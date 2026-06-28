"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useConnectionState, useDataChannel, useLocalParticipant } from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import {
  BOARD_TOPIC,
  clamp01,
  decodeBoardMessage,
  encodeBoardMessage,
  isHexColor,
  MAX_ID_LEN,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES,
  MAX_ARROWS,
  MAX_FIGURES,
  normToRect,
  safeColor,
  safeLabel,
  sanitizeArrow,
  sanitizeArrows,
  sanitizeBgUrl,
  sanitizeClock,
  sanitizeFigure,
  sanitizeFigures,
  sanitizePoints,
  sanitizeStrokes,
  type Arrow,
  type ArrowStyle,
  type BoardMessage,
  type Figure,
  type Point,
  type Stroke,
  type StrokeMode,
} from "@/lib/board";
import {
  getBoardColor,
  getBoardSize,
  getHostKey,
  setBoardColor as saveBoardColor,
  setBoardSize as saveBoardSize,
} from "@/lib/clientStorage";
import Banner from "@/components/Banner";
import Icon from "@/components/Icon";
import { playSfx } from "@/lib/audio/sfx";
import BoardRail, { type Tool } from "./BoardRail";
import MapPicker from "./MapPicker";
import FigureLayer from "./FigureLayer";
import ArrowLayer from "./ArrowLayer";
import { genFigureId, nextFigureNumber } from "@/lib/boardFigures";
import { mapAspect, type GameMap } from "@/lib/maps";

// Толщину кисти выбираем в «логических» px относительно эталонной ширины доски,
// а в штрихе храним долю (px / NOMINAL_WIDTH). При рисовании доля умножается на
// фактическую ширину холста — линии масштабируются вместе с доской у всех.
const NOMINAL_WIDTH = 1000;
const MIN_SIZE = 1;
const MAX_SIZE = 20;
const PRESET_COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ffffff", "#111827"];
const DEFAULT_COLOR = "#ef4444";
const DEFAULT_SIZE = 4;
const DEFAULT_ASPECT = 16 / 9;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const clampSize = (n: number) => Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n)));

/**
 * Доска тактик: рамка с фоном-картой + прозрачный холст для рисунков. Рисунки
 * и смена фона синхронизируются всем через data-канал LiveKit (топик "board").
 * Компонент всегда смонтирован (родитель прячет его через CSS), чтобы доска
 * продолжала принимать чужие рисунки, пока смотришь демонстрацию экрана.
 *
 * Рисовать может каждый; менять фон-карту — только хост (загрузка авторизуется
 * на сервере, см. /api/upload), поэтому контролы фона показываем лишь хосту.
 */
export default function TacticsBoard({
  code,
  active,
  token,
  amHost,
}: {
  code: string;
  active: boolean;
  token: string;
  amHost: boolean;
}) {
  const { localParticipant } = useLocalParticipant();
  const connState = useConnectionState();

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Источник правды для перерисовки — мутируемый массив (не гоняем re-render на
  // каждую точку). Фон держим и в state (для рендера), и в ref (для onMessage).
  const strokesRef = useRef<Stroke[]>([]);
  const bgRef = useRef<string | null>(null);
  const [bg, setBg] = useState<string | null>(null);
  // Пропорции загруженной карты — задаём их рамке, чтобы фон не letterbox-ился и
  // линии (нормированные к рамке) совпадали с картой при любом соотношении сторон.
  const [bgAspect, setBgAspect] = useState<number | null>(null);

  // Фигурки-игроки. Источник правды для onMessage — ref; для рендера — state.
  const [figures, setFigures] = useState<Figure[]>([]);
  const figuresRef = useRef<Figure[]>([]);
  const [selectedFigId, setSelectedFigId] = useState<string | null>(null);
  const figSeq = useRef(0);
  // Уникальный токен на каждый монтаж компонента: входит в id фигурок/стрелок,
  // чтобы после перезагрузки/ремаунта счётчики с нуля не дали id, который у пиров
  // уже занят (иначе arrow-add дедупнулся бы, а fig-add перезаписал чужую фигурку).
  const mountTag = useRef<string>("");
  if (!mountTag.current) mountTag.current = Math.random().toString(36).slice(2, 8);
  // Буфер позиций для батч-отправки fig-move на кадре (драг не флудит канал).
  const figMovePending = useRef<Map<string, { x: number; y: number }>>(new Map());
  const figRafRef = useRef<number | null>(null);
  useEffect(() => {
    figuresRef.current = figures;
  }, [figures]);

  // Стрелки. Та же схема: ref для onMessage, state для рендера.
  const [arrows, setArrows] = useState<Arrow[]>([]);
  const arrowsRef = useRef<Arrow[]>([]);
  const [selectedArrowId, setSelectedArrowId] = useState<string | null>(null);
  const arrowSeq = useRef(0);
  useEffect(() => {
    arrowsRef.current = arrows;
  }, [arrows]);

  // Инструмент. Цвет/толщина — также в localStorage (восстановим при входе).
  const [tool, setTool] = useState<Tool>("draw");
  const [arrowStyle, setArrowStyle] = useState<ArrowStyle>("solid");
  // Режим штриха выводится из инструмента (кисть → draw, ластик → erase).
  const strokeMode: StrokeMode = tool === "erase" ? "erase" : "draw";
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [urlInput, setUrlInput] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Версии состояния (логические часы), чтобы поздние/повторные пакеты не
  // воскрешали стёртое. epoch растёт на каждую «Очистить»; bgVer — на смену фона.
  const epochRef = useRef(0);
  const bgVerRef = useRef(0);
  // Кто выставил текущий фон — для детерминированного разрешения ничьей версий
  // (если двое одновременно сменили фон на одной версии, выигрывает больший id).
  const bgSetterRef = useRef("");

  // Текущий рисуемый штрих и буфер точек, ещё не отправленных по сети.
  const activeRef = useRef<Stroke | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const activeEpochRef = useRef(0);
  const pendingRef = useRef<Point[]>([]);
  const rafRef = useRef<number | null>(null);
  const strokeSeq = useRef(0);

  // Свежие send/identity держим в ref, чтобы onMessage был стабильным (его
  // идентичность — зависимость useMemo внутри useDataChannel; иначе пере-подписка).
  const sendRef = useRef<((payload: Uint8Array, opts: { reliable?: boolean; destinationIdentities?: string[] }) => Promise<void>) | null>(null);
  const identityRef = useRef("");
  useEffect(() => {
    identityRef.current = localParticipant.identity;
  }, [localParticipant.identity]);

  // --- Восстановление настроек кисти ---
  useEffect(() => {
    const c = getBoardColor();
    const s = getBoardSize();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- одноразовое чтение localStorage
    if (isHexColor(c)) setColor(c);
    if (s != null) setSize(clampSize(s));
  }, []);

  // --- Рисование на холсте ---
  const applyStrokeStyle = useCallback((ctx: CanvasRenderingContext2D, s: Stroke, w: number) => {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(1, s.size * w);
    ctx.globalCompositeOperation = s.mode === "erase" ? "destination-out" : "source-over";
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
  }, []);

  // Рисует штрих, начиная с индекса `from` (0 — весь штрих целиком). Это позволяет
  // дорисовывать только новые точки, не перерисовывая всю доску на каждый пакет.
  const drawStrokeFrom = useCallback(
    (ctx: CanvasRenderingContext2D, s: Stroke, w: number, h: number, from: number) => {
      if (s.points.length === 0) return;
      applyStrokeStyle(ctx, s, w);
      if (s.points.length === 1) {
        // Одиночный тап — рисуем точку (кружок), иначе её не было бы видно.
        const [x, y] = s.points[0];
        ctx.beginPath();
        ctx.arc(x * w, y * h, Math.max(0.5, (s.size * w) / 2), 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Соединяем с предыдущей точкой (from-1), чтобы не было разрыва в линии.
        const start = Math.max(1, from);
        ctx.beginPath();
        ctx.moveTo(s.points[start - 1][0] * w, s.points[start - 1][1] * h);
        for (let i = start; i < s.points.length; i++) {
          ctx.lineTo(s.points[i][0] * w, s.points[i][1] * h);
        }
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "source-over";
    },
    [applyStrokeStyle],
  );

  // Дорисовать один штрих на текущем холсте, начиная с индекса `from`.
  const paintStroke = useCallback(
    (s: Stroke, from: number) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      drawStrokeFrom(ctx, s, canvas.width, canvas.height, from);
    },
    [drawStrokeFrom],
  );

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokesRef.current) drawStrokeFrom(ctx, s, canvas.width, canvas.height, 0);
  }, [drawStrokeFrom]);

  // Догнать чужую эпоху: пропустили «Очистить» — поднимаем epoch и чистим ВСЕ
  // слои (штрихи + фигурки), иначе стёртое «воскресло» бы после ближайшего redraw.
  const catchUpEpoch = useCallback(
    (e: number) => {
      epochRef.current = e;
      strokesRef.current = [];
      activeRef.current = null;
      setFigures([]);
      setArrows([]);
      setSelectedFigId(null);
      setSelectedArrowId(null);
      redraw();
    },
    [redraw],
  );

  // Буфер холста должен совпадать по размеру (и пропорциям) с контейнером, иначе
  // рисунок растянется. Подгоняем размер и перерисовываем.
  const syncSize = useCallback(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return; // скрыто — нечего мерить
    // Буфер холста — в ФИЗИЧЕСКИХ пикселях (×devicePixelRatio), CSS-размер остаётся
    // 100% (см. класс канваса). Иначе на HiDPI/зуме рисунок размывался бы. Все
    // координаты нормированы 0..1 и умножаются на canvas.width/height, поэтому
    // дополнительный ctx.scale не нужен — масштаб учитывается автоматически.
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    redraw();
  }, [redraw]);

  // При показе доски (active → true) холст мог быть скрыт и не измерен — мерим и
  // перерисовываем сейчас. useLayoutEffect — чтобы успеть до кадра, без мигания.
  useLayoutEffect(() => {
    if (active) syncSize();
  }, [active, syncSize]);

  // Пока доска видима — следим за изменением её размера (ресайз окна, смена
  // пропорций под загруженную карту и т.п.).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => syncSize());
    ro.observe(container);
    return () => ro.disconnect();
  }, [syncSize]);

  // --- Сеть ---
  const broadcast = useCallback(
    (msg: BoardMessage, destinationIdentities?: string[]) => {
      // best-effort: до подключения publishData отклонится — молча игнорируем.
      void sendRef.current?.(encodeBoardMessage(msg), {
        reliable: true,
        destinationIdentities,
      }).catch(() => {});
    },
    [],
  );

  // Меняем фон. Для встроенной карты пропорции известны сразу (mapAspect) — рамка
  // встаёт квадратной без мелькания DEFAULT_ASPECT; для произвольного URL — null,
  // и пропорции уточнит <img onLoad>. Работает и локально, и у тех, кому фон приехал.
  const applyBg = useCallback((url: string | null) => {
    bgRef.current = url;
    setBg(url);
    setBgAspect(mapAspect(url));
  }, []);

  // Отдаём снимок доски АДРЕСНО автору sync-req. Один пакет data-канала ограничен
  // по размеру (~64 КБ у WebRTC), поэтому режем по числу точек. Слияние по id
  // (берём более длинную версию штриха) делает части идемпотентными, поэтому
  // длинный штрих отправляем растущими префиксами — без потерь и без дублей.
  const sendSnapshot = useCallback(
    (to: string) => {
      const MAX_POINTS = 1500; // ~25 КБ JSON при 4 знаках на координату — под лимит
      // 1) Заголовок: эпоха + фон. Доедет даже при пустой доске и синхронит epoch/bg.
      broadcast(
        {
          t: "sync-state",
          epoch: epochRef.current,
          strokes: [],
          bg: bgRef.current,
          bgVer: bgVerRef.current,
          figures: figuresRef.current,
          arrows: arrowsRef.current,
        },
        [to],
      );
      // 2) Штрихи батчами по числу точек.
      let batch: Stroke[] = [];
      let pts = 0;
      const flush = () => {
        if (batch.length === 0) return;
        broadcast({ t: "sync-state", epoch: epochRef.current, strokes: batch, bg: null, bgVer: 0 }, [to]);
        batch = [];
        pts = 0;
      };
      for (const s of strokesRef.current) {
        if (s.points.length > MAX_POINTS) {
          // Один огромный штрих не влезает в пакет — режем на под-штрихи с
          // отдельными id (по ≤MAX_POINTS точек). Соседние делят граничную точку,
          // поэтому рисуются непрерывно; отдельные id делают части идемпотентными.
          flush();
          for (let i = 0, part = 0; i < s.points.length; i += MAX_POINTS, part++) {
            const start = i === 0 ? 0 : i - 1; // граничная точка для стыка
            const slice = { ...s, id: `${s.id}#${part}`, points: s.points.slice(start, i + MAX_POINTS) };
            broadcast({ t: "sync-state", epoch: epochRef.current, strokes: [slice], bg: null, bgVer: 0 }, [to]);
          }
          continue;
        }
        if (pts + s.points.length > MAX_POINTS) flush();
        batch.push(s);
        pts += s.points.length;
      }
      flush();
    },
    [broadcast],
  );

  // Стабильный обработчик входящих сообщений (всё берём из ref-ов). Все данные
  // приходят от других участников — поэтому валидируем форму перед применением.
  const onMessage = useCallback(
    (raw: { payload: Uint8Array; from?: { identity: string } }) => {
      const msg = decodeBoardMessage(raw.payload);
      if (!msg) return;
      switch (msg.t) {
        case "stroke": {
          const e = sanitizeClock(msg.epoch);
          if (e === null || e < epochRef.current) break; // битый/старый epoch — игнор
          const pts = sanitizePoints(msg.points);
          if (pts.length === 0 || typeof msg.id !== "string" || !msg.id || msg.id.length > MAX_ID_LEN)
            break;
          if (e > epochRef.current) catchUpEpoch(e); // пропустили «Очистить» — догоняем
          const list = strokesRef.current;
          let s = list.find((x) => x.id === msg.id);
          if (!s) {
            if (list.length >= MAX_STROKES) break; // защита от переполнения доски
            s = {
              id: msg.id,
              color: safeColor(msg.color, "#000000"),
              size: Number.isFinite(msg.size) ? clamp01(msg.size) : 0.004,
              mode: msg.mode === "erase" ? "erase" : "draw",
              points: [],
            };
            list.push(s);
          }
          const prev = s.points.length;
          if (prev < MAX_POINTS_PER_STROKE) {
            const room = MAX_POINTS_PER_STROKE - prev;
            s.points.push(...(pts.length > room ? pts.slice(0, room) : pts));
            // Инкрементальная дорисовка верна только для ВЕРХНЕГО source-over
            // штриха. Ластик (destination-out) и дорисовка не-верхнего штриха
            // зависят от порядка наложения → полная перерисовка по порядку массива
            // (иначе при одновременном рисовании/стирании доски пиров разъезжаются:
            // стёртое «возвращалось» бы после ближайшего redraw).
            if (s.mode === "erase" || s !== list[list.length - 1]) redraw();
            else paintStroke(s, prev); // дорисовываем только новые точки, не всю доску
          }
          break;
        }
        case "clear": {
          const e = sanitizeClock(msg.epoch);
          if (e === null) break; // битый epoch — игнор
          if (e > epochRef.current) catchUpEpoch(e); // чистит штрихи + фигурки
          break;
        }
        case "fig-add": {
          const e = sanitizeClock(msg.epoch);
          if (e === null || e < epochRef.current) break;
          if (e > epochRef.current) catchUpEpoch(e);
          const fig = sanitizeFigure(msg.fig);
          if (!fig) break;
          // upsert по id: и создание, и правка команды/подписи/позиции.
          setFigures((prev) => {
            const i = prev.findIndex((f) => f.id === fig.id);
            if (i !== -1) {
              const n = prev.slice();
              n[i] = fig;
              return n;
            }
            if (prev.length >= MAX_FIGURES) return prev; // потолок
            return [...prev, fig];
          });
          break;
        }
        case "fig-move": {
          const e = sanitizeClock(msg.epoch);
          if (e === null || e < epochRef.current) break;
          if (e > epochRef.current) {
            catchUpEpoch(e);
            break;
          }
          if (typeof msg.id !== "string") break;
          if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) break;
          const x = clamp01(msg.x);
          const y = clamp01(msg.y);
          // Если фигурки с таким id ещё нет — игнорируем (создать из move нельзя:
          // нет команды/подписи). На reliable-ordered канале fig-add всегда раньше
          // fig-move того же отправителя; редкий рассинхрон лечит снапшот при reconnect.
          setFigures((prev) => prev.map((f) => (f.id === msg.id ? { ...f, x, y } : f)));
          break;
        }
        case "fig-del": {
          const e = sanitizeClock(msg.epoch);
          if (e === null || e < epochRef.current) break;
          if (e > epochRef.current) catchUpEpoch(e); // пропустили «Очистить» — догоняем
          if (typeof msg.id !== "string") break;
          setFigures((prev) => prev.filter((f) => f.id !== msg.id));
          break;
        }
        case "arrow-add": {
          const e = sanitizeClock(msg.epoch);
          if (e === null || e < epochRef.current) break;
          if (e > epochRef.current) catchUpEpoch(e);
          const arrow = sanitizeArrow(msg.arrow);
          if (!arrow) break;
          setArrows((prev) => {
            if (prev.some((a) => a.id === arrow.id)) return prev; // идемпотентность
            if (prev.length >= MAX_ARROWS) return prev;
            return [...prev, arrow];
          });
          break;
        }
        case "arrow-del": {
          const e = sanitizeClock(msg.epoch);
          if (e === null || e < epochRef.current) break;
          if (e > epochRef.current) catchUpEpoch(e); // пропустили «Очистить» — догоняем
          if (typeof msg.id !== "string") break;
          setArrows((prev) => prev.filter((a) => a.id !== msg.id));
          break;
        }
        case "bg": {
          const ver = sanitizeClock(msg.ver);
          if (ver === null) break;
          const from = raw.from?.identity ?? "";
          // Применяем более новую версию; при равной версии (одновременная смена
          // у двоих) детерминированно выигрывает больший identity — иначе доски
          // разъехались бы навсегда.
          if (ver < bgVerRef.current) break;
          if (ver === bgVerRef.current && from <= bgSetterRef.current) break;
          const url = msg.url === null ? null : sanitizeBgUrl(msg.url);
          // Невалидный непустой URL не применяем и версию НЕ двигаем (иначе сожгли
          // бы версию и настоящий фон уже не доехал бы).
          if (msg.url !== null && !url) break;
          bgVerRef.current = ver;
          bgSetterRef.current = from;
          applyBg(url);
          break;
        }
        case "sync-req": {
          // Отвечаем снимком только если доске есть что отдать, адресно автору.
          const id = raw.from?.identity;
          if (
            id &&
            (strokesRef.current.length > 0 ||
              bgRef.current ||
              figuresRef.current.length > 0 ||
              arrowsRef.current.length > 0)
          )
            sendSnapshot(id);
          break;
        }
        case "sync-state": {
          const e = sanitizeClock(msg.epoch);
          let changed = false;
          // Штрихи учитываем, только если снимок не старее нашей последней очистки.
          if (e !== null && e >= epochRef.current) {
            if (e > epochRef.current) {
              catchUpEpoch(e); // единая очистка всех слоёв + сброс выделения
              changed = true;
            }
            // Слияние по id: не теряем своё, безопасно при reconnect и частями.
            const list = strokesRef.current;
            const byId = new Map(list.map((s) => [s.id, s]));
            for (const s of sanitizeStrokes(msg.strokes)) {
              const existing = byId.get(s.id);
              if (!existing) {
                if (list.length >= MAX_STROKES) break; // защита от переполнения доски
                list.push(s);
                byId.set(s.id, s);
                changed = true;
              } else if (s.points.length > existing.points.length) {
                existing.points = s.points; // берём более полную версию штриха
                changed = true;
              }
            }
          }
          // Фигурки из снапшота — слияние по id (не старее нашей последней очистки).
          if (msg.figures && e !== null && e >= epochRef.current) {
            const incoming = sanitizeFigures(msg.figures);
            setFigures((prev) => {
              const byId = new Map(prev.map((f) => [f.id, f]));
              for (const f of incoming) {
                if (byId.size < MAX_FIGURES || byId.has(f.id)) byId.set(f.id, f);
              }
              return Array.from(byId.values());
            });
          }
          // Стрелки из снапшота — слияние по id.
          if (msg.arrows && e !== null && e >= epochRef.current) {
            const incoming = sanitizeArrows(msg.arrows);
            setArrows((prev) => {
              const byId = new Map(prev.map((a) => [a.id, a]));
              for (const a of incoming) {
                if (byId.size < MAX_ARROWS || byId.has(a.id)) byId.set(a.id, a);
              }
              return Array.from(byId.values());
            });
          }
          // Фон — по своей версии, независимо от epoch. Невалидный непустой URL
          // игнорируем без сдвига версии (не затираем уже показанный фон).
          const bgVer = sanitizeClock(msg.bgVer);
          const bgFrom = raw.from?.identity ?? "";
          // Тот же tie-break по identity, что и в живой ветке "bg": при равной
          // версии выигрывает больший identity — иначе поздний участник мог бы
          // застрять на другом фоне, чем у комнаты. (Снимок несёт identity
          // отправителя, не исходного автора фона — для частого случая хватает.)
          if (
            bgVer !== null &&
            (bgVer > bgVerRef.current ||
              (bgVer === bgVerRef.current && bgFrom > bgSetterRef.current))
          ) {
            const url = msg.bg === null ? null : sanitizeBgUrl(msg.bg);
            if (msg.bg === null || url) {
              bgVerRef.current = bgVer;
              bgSetterRef.current = bgFrom;
              applyBg(url);
            }
          }
          if (changed) redraw();
          break;
        }
      }
    },
    [redraw, paintStroke, applyBg, sendSnapshot, catchUpEpoch],
  );

  const { send } = useDataChannel(BOARD_TOPIC, onMessage);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  // Поздний вход И переподключение: как только соединение установлено — просим
  // снимок доски. Запрашиваем на КАЖДОМ переходе в Connected (а не только при
  // пустой доске): иначе после короткого обрыва участник с уже накопленным
  // состоянием никогда бы не догнал пропущенные за время обрыва штрихи/очистки.
  // Версии (epoch/bgVer) и слияние по id делают повторный снимок безопасным
  // (старое не воскресает), а на 2–6 участников лишние снимки некритичны.
  useEffect(() => {
    if (connState === ConnectionState.Connected) broadcast({ t: "sync-req" });
  }, [connState, broadcast]);

  // --- Сеть: отправка своего штриха батчами ---
  const flushPending = useCallback(() => {
    rafRef.current = null;
    const s = activeRef.current;
    if (!s || pendingRef.current.length === 0) return;
    const points = pendingRef.current;
    pendingRef.current = [];
    broadcast({
      t: "stroke",
      epoch: activeEpochRef.current, // эпоха на момент НАЧАЛА штриха
      id: s.id,
      color: s.color,
      size: s.size,
      mode: s.mode,
      points,
    });
  }, [broadcast]);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(flushPending);
  }, [flushPending]);

  const endStroke = useCallback(() => {
    if (!activeRef.current) return;
    flushPending();
    activeRef.current = null;
    activePointerIdRef.current = null;
  }, [flushPending]);

  // Завершаем активный штрих, если доску скрыли (ушли на «Экран») ИЛИ окно/вкладка
  // потеряли фокус во время рисования — иначе хвост штриха не долетит, а activeRef
  // «зависнет». pointerup на скрытом/расфокусированном холсте может не прийти.
  useEffect(() => {
    if (!active) endStroke();
  }, [active, endStroke]);
  useEffect(() => {
    const end = () => endStroke();
    const onVisibility = () => {
      if (document.hidden) endStroke();
    };
    window.addEventListener("blur", end);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", end);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [endStroke]);

  // На размонтировании отменяем запланированный кадр отправки — иначе RAF сработал
  // бы после анмаунта (трогал бы refs и слал бы в уже снятый data-канал).
  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (figRafRef.current != null) cancelAnimationFrame(figRafRef.current);
    };
  }, []);

  // --- Фигурки: добавление, правка подписи, перемещение, удаление ---
  const addFigure = useCallback(
    (team: "ct" | "t") => {
      // id берём вне апдейтера (счётчик растёт один раз). Номер считаем ВНУТРИ по
      // актуальному prev — иначе два быстрых клика подряд (ref ещё не обновлён
      // эффектом) дали бы одинаковый номер. fig-add идемпотентен по id, поэтому
      // повторный вызов апдейтера в StrictMode не плодит дублей у получателей.
      const id = genFigureId(`${identityRef.current}.${mountTag.current}`, figSeq.current++);
      setFigures((prev) => {
        if (prev.length >= MAX_FIGURES) return prev;
        const fig: Figure = { id, team, label: String(nextFigureNumber(prev, team)), x: 0.5, y: 0.5 };
        broadcast({ t: "fig-add", epoch: epochRef.current, fig });
        return [...prev, fig];
      });
    },
    [broadcast],
  );

  // Правка подписи = повторный fig-add (upsert по id). Чистим подпись санитайзером.
  const editFigureLabel = useCallback(
    (id: string, label: string) => {
      const cur = figuresRef.current.find((f) => f.id === id);
      if (!cur) return;
      const fig: Figure = { ...cur, label: safeLabel(label) };
      setFigures((prev) => prev.map((f) => (f.id === id ? fig : f)));
      broadcast({ t: "fig-add", epoch: epochRef.current, fig });
    },
    [broadcast],
  );

  // Во время драга и локальный ре-рендер, и отправка по сети — батчем на кадр:
  // pointermove может срабатывать чаще кадра, а так мы делаем максимум один
  // setFigures + один пакет fig-move в кадр на каждую двигающуюся фигурку.
  const flushFigMoves = useCallback(() => {
    figRafRef.current = null;
    const pending = figMovePending.current;
    if (pending.size === 0) return;
    setFigures((prev) => prev.map((f) => (pending.has(f.id) ? { ...f, ...pending.get(f.id)! } : f)));
    for (const [id, p] of pending) {
      broadcast({ t: "fig-move", epoch: epochRef.current, id, x: p.x, y: p.y });
    }
    pending.clear();
  }, [broadcast]);

  const moveFigureLive = useCallback(
    (id: string, x: number, y: number) => {
      figMovePending.current.set(id, { x, y });
      if (figRafRef.current == null) figRafRef.current = requestAnimationFrame(flushFigMoves);
    },
    [flushFigMoves],
  );

  const moveFigureCommit = useCallback(
    (id: string, x: number, y: number) => {
      figMovePending.current.delete(id); // финальную позицию шлём сами — не дублируем в кадре
      setFigures((prev) => prev.map((f) => (f.id === id ? { ...f, x, y } : f)));
      broadcast({ t: "fig-move", epoch: epochRef.current, id, x, y }); // гарантированно финальная позиция
    },
    [broadcast],
  );

  const deleteFigure = useCallback(
    (id: string) => {
      setFigures((prev) => prev.filter((f) => f.id !== id));
      setSelectedFigId((cur) => (cur === id ? null : cur));
      broadcast({ t: "fig-del", epoch: epochRef.current, id });
    },
    [broadcast],
  );

  // --- Стрелки: добавление и удаление ---
  const addArrow = useCallback(
    (g: { x1: number; y1: number; x2: number; y2: number }) => {
      const arrow: Arrow = {
        id: `${identityRef.current}.${mountTag.current}-arr-${arrowSeq.current++}`,
        color,
        style: arrowStyle,
        ...g,
      };
      setArrows((prev) => (prev.length >= MAX_ARROWS ? prev : [...prev, arrow]));
      broadcast({ t: "arrow-add", epoch: epochRef.current, arrow });
    },
    [broadcast, color, arrowStyle],
  );

  const deleteArrow = useCallback(
    (id: string) => {
      setArrows((prev) => prev.filter((a) => a.id !== id));
      setSelectedArrowId((cur) => (cur === id ? null : cur));
      broadcast({ t: "arrow-del", epoch: epochRef.current, id });
    },
    [broadcast],
  );

  // Выделение фигурки и стрелки взаимоисключающее: выбор одного снимает другой,
  // иначе по Delete удалялась бы только фигурка, а выделенная стрелка «залипала».
  const selectFigure = useCallback((id: string | null) => {
    setSelectedFigId(id);
    if (id !== null) setSelectedArrowId(null);
  }, []);
  const selectArrow = useCallback((id: string | null) => {
    setSelectedArrowId(id);
    if (id !== null) setSelectedFigId(null);
  }, []);

  // Delete/Backspace удаляет выделенную фигурку или стрелку (если фокус не в поле ввода).
  useEffect(() => {
    if (!active || (!selectedFigId && !selectedArrowId)) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Delete" && ev.key !== "Backspace") return;
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      ev.preventDefault();
      if (selectedFigId) deleteFigure(selectedFigId);
      else if (selectedArrowId) deleteArrow(selectedArrowId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, selectedFigId, selectedArrowId, deleteFigure, deleteArrow]);

  // --- Ввод указателем ---
  const pointFromEvent = useCallback((e: React.PointerEvent): Point => {
    return normToRect(e.clientX, e.clientY, canvasRef.current!.getBoundingClientRect());
  }, []);

  function handlePointerDown(e: React.PointerEvent) {
    if (tool !== "draw" && tool !== "erase") return; // рисует только кисть/ластик
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (activeRef.current) return; // уже рисуем другим указателем (мультитач) — игнор
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture может бросить, если указатель уже неактивен — не критично.
    }
    activePointerIdRef.current = e.pointerId;
    activeEpochRef.current = epochRef.current;
    const p = pointFromEvent(e);
    const stroke: Stroke = {
      id: `${identityRef.current}-${strokeSeq.current++}`,
      color,
      size: size / NOMINAL_WIDTH,
      mode: strokeMode,
      points: [p],
    };
    activeRef.current = stroke;
    strokesRef.current.push(stroke);
    pendingRef.current = [p];
    paintStroke(stroke, 0);
    scheduleFlush();
  }

  function handlePointerMove(e: React.PointerEvent) {
    const s = activeRef.current;
    if (!s || e.pointerId !== activePointerIdRef.current) return; // только активный указатель
    const p = pointFromEvent(e);
    s.points.push(p);
    pendingRef.current.push(p);
    paintStroke(s, s.points.length - 1);
    scheduleFlush();
  }

  function handlePointerEnd(e: React.PointerEvent) {
    if (e.pointerId !== activePointerIdRef.current) return;
    endStroke();
  }

  // --- Тулбар: действия ---
  function pickColor(c: string) {
    setColor(c);
    saveBoardColor(c);
  }
  function changeSize(v: number) {
    const s = clampSize(v);
    setSize(s);
    saveBoardSize(s);
  }
  function clearBoard() {
    epochRef.current += 1; // новая эпоха — отбрасывает поздние/повторные старые штрихи
    strokesRef.current = [];
    activeRef.current = null;
    setFigures([]);
    setArrows([]);
    setSelectedFigId(null);
    setSelectedArrowId(null);
    redraw();
    playSfx("board-clear");
    broadcast({ t: "clear", epoch: epochRef.current });
  }
  function setBackground(url: string | null) {
    bgVerRef.current += 1; // новая версия фона — корректно доезжает и снятие фона
    bgSetterRef.current = identityRef.current; // мы — текущий «владелец» версии фона
    applyBg(url);
    broadcast({ t: "bg", ver: bgVerRef.current, url });
  }
  function applyUrlBg() {
    const url = urlInput.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      setUploadError("Ссылка должна начинаться с http:// или https://");
      return;
    }
    setUploadError(null);
    setBackground(url);
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // позволяем выбрать тот же файл повторно
    if (!file) return;
    setUploadError(null);
    if (!file.type.startsWith("image/")) {
      setUploadError("Это не картинка");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError("Файл больше 4 МБ");
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("code", code);
      // Авторизация хоста (как в /api/moderate): токен текущего хоста + ключ.
      form.append("callerToken", token);
      const hostKey = getHostKey(code);
      if (hostKey) form.append("hostKey", hostKey);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        setUploadError(data.error ?? "Не удалось загрузить карту");
        return;
      }
      setBackground(data.url as string);
    } catch {
      setUploadError("Сеть недоступна. Попробуйте ещё раз.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      {/* Смена фон-карты — только хост (загрузка авторизуется на сервере). */}
      {amHost && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="btn btn--sm cursor-pointer">
            <Icon name="map" size={15} />
            {uploading ? "Загрузка…" : "Загрузить карту"}
            <input
              type="file"
              accept="image/*"
              onChange={handleUpload}
              disabled={uploading}
              className="hidden"
            />
          </label>
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applyUrlBg()}
            placeholder="…или ссылка на картинку"
            className="field min-w-0 flex-1"
          />
          <button onClick={applyUrlBg} className="btn btn--sm">
            Применить
          </button>
          {bg && (
            <button onClick={() => setBackground(null)} className="btn btn--sm">
              Убрать фон
            </button>
          )}
        </div>
      )}

      {uploadError && <Banner tone="warn">{uploadError}</Banner>}

      <div
        ref={containerRef}
        className="stage relative w-full"
        style={{ aspectRatio: String(bgAspect ?? DEFAULT_ASPECT) }}
      >
        <BoardRail
          tool={tool}
          onTool={setTool}
          color={color}
          presetColors={PRESET_COLORS}
          onColor={pickColor}
          size={size}
          minSize={MIN_SIZE}
          maxSize={MAX_SIZE}
          onSize={changeSize}
          arrowStyle={arrowStyle}
          onArrowStyle={setArrowStyle}
          onAddFigure={addFigure}
          onClear={clearBoard}
        />
        {amHost && (
          <MapPicker
            currentSrc={bg}
            onPick={(m: GameMap) => setBackground(m.src)}
          />
        )}
        {/* Фон — отдельный <img>, а не CSS background: так нельзя подсунуть
            произвольную CSS-строку, и рамка точно совпадает с картинкой.
            next/image тут не подходит — src произвольный (любой URL карты,
            ссылка участника или data:-URI), его не сконфигурировать под remotePatterns. */}
        {bg && (
          // eslint-disable-next-line @next/next/no-img-element -- произвольный src карты, next/image неприменим
          <img
            src={bg}
            alt=""
            draggable={false}
            // Пропорции рамки берём из реально загруженной картинки — рамка
            // совпадает с картой, линии (нормированные к рамке) ложатся ровно.
            onLoad={(e) => {
              const el = e.currentTarget;
              if (el.naturalHeight > 0) setBgAspect(el.naturalWidth / el.naturalHeight);
            }}
            className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
          />
        )}
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onLostPointerCapture={handlePointerEnd}
          className={
            "absolute inset-0 h-full w-full touch-none " +
            (tool === "draw" || tool === "erase" ? "cursor-crosshair" : "pointer-events-none")
          }
        />
        <ArrowLayer
          arrows={arrows}
          drawing={tool === "arrow"}
          selecting={tool === "move"}
          color={color}
          style={arrowStyle}
          selectedId={selectedArrowId}
          onSelect={selectArrow}
          onCommit={addArrow}
          onDelete={deleteArrow}
        />
        <FigureLayer
          figures={figures}
          draggable={tool === "move"}
          selectedId={selectedFigId}
          onSelect={selectFigure}
          onMove={moveFigureLive}
          onMoveEnd={moveFigureCommit}
          onEditLabel={editFigureLabel}
          onDelete={deleteFigure}
        />
      </div>
    </section>
  );
}
