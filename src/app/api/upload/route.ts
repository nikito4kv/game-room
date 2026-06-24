import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { loadPublicMeta, verifyHostCredentials } from "@/lib/livekit";
import { loadAuth } from "@/lib/roomSecret";
import { clientIp, rateLimited, uploadLimit } from "@/lib/ratelimit";

// Загрузка фон-карты доски в Vercel Blob. По data-каналу LiveKit мы потом гоняем
// только URL (мелкий), а не саму картинку. Картинки складываем под префикс
// maps/<код комнаты>/ — так их удобно удалить целиком при закрытии комнаты
// (см. вебхук /api/livekit-webhook).
//
// Загружать карту может ТОЛЬКО хост (как и прочая модерация): иначе кто угодно,
// зная код комнаты, мог бы заливать файлы в наше платное хранилище и менять фон
// у всех. Авторизация — тем же способом, что и /api/moderate (hostKey/токен).

const MAX_BYTES = 4 * 1024 * 1024; // ~лимит тела serverless; крупнее — клиентская загрузка (P1)

/** Код комнаты в имени файла — только наш алфавит, чтобы не подсунули путь. */
function safeCode(code: string): string | null {
  const c = code.trim().toUpperCase();
  return /^[A-Z0-9]{1,12}$/.test(c) ? c : null;
}

type ImageKind = { ext: string; contentType: string };

/**
 * Определяет тип картинки по её РЕАЛЬНЫМ байтам (сигнатуре), а не по присланному
 * клиентом file.type — тот легко подделать. Возвращает null, если это не одна из
 * поддерживаемых картинок.
 */
function sniffImage(bytes: Uint8Array): ImageKind | null {
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { ext: "png", contentType: "image/png" };
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: "jpg", contentType: "image/jpeg" };
  }
  // GIF: 47 49 46 38 ("GIF8")
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { ext: "gif", contentType: "image/gif" };
  }
  // WEBP: "RIFF"...."WEBP"
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { ext: "webp", contentType: "image/webp" };
  }
  return null;
}

export async function POST(request: Request) {
  const limited = await rateLimited(uploadLimit(), clientIp(request));
  if (limited) return limited;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
  }

  const file = form.get("file");
  const code = safeCode(String(form.get("code") ?? ""));
  const callerToken = String(form.get("callerToken") ?? "") || undefined;
  const hostKey = String(form.get("hostKey") ?? "") || undefined;

  if (!code) {
    return NextResponse.json({ error: "Не указана комната" }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Файл не получен" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Файл больше 4 МБ" }, { status: 413 });
  }

  // Комната существует + загружающий — хост. Иначе кто угодно мог бы складывать
  // файлы под произвольным кодом (их не удалил бы вебхук room_finished) и менять
  // фон у всех участников.
  let meta;
  let auth;
  try {
    [meta, auth] = await Promise.all([loadPublicMeta(code), loadAuth(code)]);
  } catch (err) {
    console.error("load room state failed", err);
    return NextResponse.json({ error: "Сервис недоступен. Попробуйте позже." }, { status: 502 });
  }
  if (!meta || !auth) {
    return NextResponse.json({ error: "Комната не найдена" }, { status: 404 });
  }
  // Менять фон у всех может только ДЕЙСТВУЮЩИЙ хост (тот, чей токен совпал с
  // hostIdentity). Один мастер-ключ власти не даёт — она отзывается при передаче.
  // allowExpiredToken: как и в /api/moderate, токен — лишь доказательство личности
  // (грант на вход остаётся 30-минутным). Иначе хост не мог бы менять карту через
  // полчаса, оставаясь в комнате. Ник из токена всё равно сверяется с hostIdentity.
  const { isCurrentHost } = await verifyHostCredentials(meta, auth, {
    hostKey,
    callerToken,
    code,
    allowExpiredToken: true,
  });
  if (!isCurrentHost) {
    return NextResponse.json({ error: "Нужны права хоста" }, { status: 403 });
  }

  // Проверяем РЕАЛЬНОЕ содержимое: первые байты должны быть картинкой.
  const arrayBuffer = await file.arrayBuffer();
  const kind = sniffImage(new Uint8Array(arrayBuffer));
  if (!kind) {
    return NextResponse.json({ error: "Это не картинка" }, { status: 400 });
  }

  try {
    // addRandomSuffix: имя уникально, прошлые карты комнаты не перетираются —
    // все удалятся разом по префиксу при закрытии комнаты. contentType берём из
    // сигнатуры, а не из присланного типа.
    const blob = await put(`maps/${code}/map.${kind.ext}`, Buffer.from(arrayBuffer), {
      access: "public",
      addRandomSuffix: true,
      contentType: kind.contentType,
    });
    return NextResponse.json({ url: blob.url });
  } catch (err) {
    console.error("blob upload failed", err);
    return NextResponse.json(
      { error: "Не удалось загрузить карту. Попробуйте ещё раз." },
      { status: 502 },
    );
  }
}
