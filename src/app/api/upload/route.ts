import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { getRoomService } from "@/lib/livekit";

// Загрузка фон-карты доски в Vercel Blob. По data-каналу LiveKit мы потом гоняем
// только URL (мелкий), а не саму картинку. Картинки складываем под префикс
// maps/<код комнаты>/ — так их удобно удалить целиком при закрытии комнаты
// (см. вебхук /api/livekit-webhook).

const MAX_BYTES = 4 * 1024 * 1024; // ~лимит тела serverless; крупнее — клиентская загрузка (P1)

/** Код комнаты в имени файла — только наш алфавит, чтобы не подсунули путь. */
function safeCode(code: string): string | null {
  const c = code.trim().toUpperCase();
  return /^[A-Z0-9]{1,12}$/.test(c) ? c : null;
}

function extFor(type: string): string {
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  return "jpg";
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
  }

  const file = form.get("file");
  const code = safeCode(String(form.get("code") ?? ""));

  if (!code) {
    return NextResponse.json({ error: "Не указана комната" }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Файл не получен" }, { status: 400 });
  }
  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: "Это не картинка" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Файл больше 4 МБ" }, { status: 413 });
  }

  // Пускаем грузить только в реально существующую комнату. Иначе кто угодно мог
  // бы складывать файлы под произвольным кодом, и их никогда бы не удалил вебхук
  // room_finished (он срабатывает только для настоящих комнат).
  try {
    const rooms = await getRoomService().listRooms([code]);
    if (!rooms[0]) {
      return NextResponse.json({ error: "Комната не найдена" }, { status: 404 });
    }
  } catch (err) {
    console.error("listRooms failed", err);
    return NextResponse.json({ error: "Сервис недоступен. Попробуйте позже." }, { status: 502 });
  }

  try {
    // addRandomSuffix: имя уникально, прошлые карты комнаты не перетираются —
    // все удалятся разом по префиксу при закрытии комнаты.
    const blob = await put(`maps/${code}/map.${extFor(file.type)}`, file, {
      access: "public",
      addRandomSuffix: true,
      contentType: file.type,
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
