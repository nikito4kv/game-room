"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useConnectionState, useDataChannel, useLocalParticipant } from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import {
  BOARD_TOPIC,
  clamp01,
  decodeBoardMessage,
  encodeBoardMessage,
  isHexColor,
  MAX_ID_LEN,
  MAX_OBJ_RADIUS,
  MIN_OBJ_RADIUS,
  MIN_ARROW_SIZE,
  MAX_ARROW_SIZE,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES,
  MAX_ARROWS,
  MAX_FIGURES,
  MAX_OBJECTS,
  normToRect,
  TEAM_COLORS,
  teamStyle,
  safeColor,
  safeLabel,
  safeNote,
  sanitizeArrow,
  sanitizeArrows,
  sanitizeBgUrl,
  sanitizeClock,
  sanitizeFigure,
  sanitizeFigures,
  sanitizeGameObject,
  sanitizeGameObjects,
  sanitizePoints,
  sanitizeStrokes,
  type Arrow,
  type ArrowStyle,
  type BoardMessage,
  type Figure,
  type GameObject,
  type ObjKind,
  type Point,
  type Stroke,
  type StrokeMode,
  type Team,
  type Technique,
} from "@/lib/board";
import {
  getBoardArrowSize,
  getBoardColor,
  getBoardObjRadii,
  getBoardSize,
  getHostKey,
  getTeamColors,
  setBoardArrowSize as saveBoardArrowSize,
  setBoardColor as saveBoardColor,
  setBoardObjRadii as saveBoardObjRadii,
  setBoardSize as saveBoardSize,
  setTeamColors as saveTeamColors,
} from "@/lib/clientStorage";
import Banner from "@/components/Banner";
import Icon from "@/components/Icon";
import { playSfx } from "@/lib/audio/sfx";
import BoardRail, { type Tool } from "./BoardRail";
import MapPicker from "./MapPicker";
import FigureLayer from "./FigureLayer";
import ArrowLayer from "./ArrowLayer";
import { genFigureId, nextFigureNumber } from "@/lib/boardFigures";
import { applyGeom, CS2_OBJECTS, genObjectId, objClass, objDef, type ObjGeom } from "@/lib/boardObjects";
import GObjectLayer from "./GObjectLayer";
import { mapAspect, type GameMap } from "@/lib/maps";

// Толщину кисти выбираем в «логических» px относительно эталонной ширины доски,
// а в штрихе храним долю (px / NOMINAL_WIDTH). При рисовании доля умножается на
// фактическую ширину холста — линии масштабируются вместе с доской у всех.
const NOMINAL_WIDTH = 1000;
const MIN_SIZE = 1;
const MAX_SIZE = 20;
const DEFAULT_COLOR = "#ef4444";
const DEFAULT_SIZE = 4;
const DEFAULT_ASPECT = 16 / 9;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const clampSize = (n: number) => Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n)));
const clampRadius = (n: number) => Math.min(MAX_OBJ_RADIUS, Math.max(MIN_OBJ_RADIUS, n));
const clampArrowSize = (n: number) => Math.min(MAX_ARROW_SIZE, Math.max(MIN_ARROW_SIZE, Math.round(n)));

// Дефолтные радиусы zone-гранат (доля ширины доски) — сид для стейта/слайдера.
const DEFAULT_OBJ_RADII: Partial<Record<ObjKind, number>> = Object.fromEntries(
  CS2_OBJECTS.filter((d) => d.cls === "zone").map((d) => [d.kind, d.defaultRadius!]),
);

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
  // Строка «рельс + сцена» — по ней (стабильная ширина, не зависит от размера
  // сцены) меряем доступное место и вписываем прямоугольник нужных пропорций.
  const rowRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

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
  // Команда, «заряженная» для постановки по клику (null — обычный режим).
  const [pendingTeam, setPendingTeam] = useState<Team | null>(null);
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

  // Игровые объекты (гранаты). Та же схема: ref для onMessage, state для рендера.
  const [objects, setObjects] = useState<GameObject[]>([]);
  const objectsRef = useRef<GameObject[]>([]);
  const [selectedObjId, setSelectedObjId] = useState<string | null>(null);
  const [objKind, setObjKind] = useState<ObjKind>("smoke");
  // Дефолтные радиусы по типу зоны (доля ширины) — «для себя», персист в localStorage.
  const [objRadii, setObjRadii] = useState<Partial<Record<ObjKind, number>>>(() => ({ ...DEFAULT_OBJ_RADII }));
  const objSeq = useRef(0);
  const objMovePending = useRef<Map<string, ObjGeom>>(new Map());
  const objRafRef = useRef<number | null>(null);
  useEffect(() => {
    objectsRef.current = objects;
  }, [objects]);

  // Инструмент. Цвет/толщина — также в localStorage (восстановим при входе).
  const [tool, setTool] = useState<Tool>("draw");
  const [arrowStyle, setArrowStyle] = useState<ArrowStyle>("solid");
  // Толщина линии стрелки (экранные px) — отдельно от кисти.
  const [arrowSize, setArrowSize] = useState(2);
  // Режим штриха выводится из инструмента (кисть → draw, ластик → erase).
  const strokeMode: StrokeMode = tool === "erase" ? "erase" : "draw";
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [size, setSize] = useState(DEFAULT_SIZE);
  // Цвет команды храним ОДНИМ значением (заливка base) — локальная косметика, не в
  // протоколе, персист в localStorage. Полный стиль {base,border,fg} выводим из base
  // (см. teamStyle), чтобы обводка/текст оставались читаемы на кастомном цвете.
  const [teamBase, setTeamBase] = useState<Record<Team, string>>(() => ({ ct: TEAM_COLORS.ct.base, t: TEAM_COLORS.t.base }));
  const teamColors = useMemo(() => ({ ct: teamStyle(teamBase.ct), t: teamStyle(teamBase.t) }), [teamBase]);
  // Кольцо-превью у курсора позиционируем императивно через ref (без setState на
  // каждое движение мыши — это горячий путь рисования).
  const cursorRingRef = useRef<HTMLDivElement>(null);
  const cursorRaf = useRef<number | null>(null);
  // Дебаунс записи «для себя» в localStorage: слайдер/пикёр шлют десятки событий
  // за драг, а синхронный setItem на каждый тик блокировал бы поток. Стейт при
  // этом обновляется вживую — откладываем только персист.
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const debouncedSave = useCallback((key: string, fn: () => void, ms = 250) => {
    clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(fn, ms);
  }, []);
  useEffect(() => {
    const timers = saveTimers.current;
    return () => { for (const id of Object.values(timers)) clearTimeout(id); };
  }, []);
  const [urlInput, setUrlInput] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Верхняя панель: меню «Ещё» (ссылка-фон/убрать) и статус копирования ссылки.
  const [moreOpen, setMoreOpen] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  // Закрытие меню «Ещё» по клику вне его (бэкдроп через position:fixed не годится —
  // backdrop-blur панели создаёт containing block, и fixed липнет к панели, не к окну).
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: PointerEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [moreOpen]);

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

  // --- Восстановление настроек (кисть, радиусы гранат, цвета команд) ---
  useEffect(() => {
    const c = getBoardColor();
    const s = getBoardSize();
    const as = getBoardArrowSize();
    const savedRadii = getBoardObjRadii();
    const savedColors = getTeamColors();
    // Радиусы гранат: мерджим сохранённое поверх дефолтов и зажимаем в пределы.
    const radii: Partial<Record<ObjKind, number>> = { ...DEFAULT_OBJ_RADII };
    for (const d of CS2_OBJECTS) {
      if (d.cls !== "zone") continue;
      const r = savedRadii[d.kind];
      if (typeof r === "number" && Number.isFinite(r)) radii[d.kind] = clampRadius(r);
    }
    /* eslint-disable react-hooks/set-state-in-effect -- одноразовое чтение localStorage */
    if (isHexColor(c)) setColor(c);
    if (s != null) setSize(clampSize(s));
    if (as != null) setArrowSize(clampArrowSize(as));
    setObjRadii(radii);
    setTeamBase((prev) => ({
      ct: isHexColor(savedColors.ct) ? savedColors.ct : prev.ct,
      t: isHexColor(savedColors.t) ? savedColors.t : prev.t,
    }));
    /* eslint-enable react-hooks/set-state-in-effect */
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
      setObjects([]);
      setSelectedFigId(null);
      setSelectedArrowId(null);
      setSelectedObjId(null);
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

  // Размер сцены вычисляем сами: вписываем прямоугольник пропорций карты в
  // доступное место (ширина обёртки × высота вьюпорта минус панель/док), беря
  // максимум, что влезает целиком. Так квадратная карта — ровный квадрат «как
  // раз по высоте», без пустот по бокам и без прыжков при смене инструмента.
  const ar = bgAspect ?? 1;
  useEffect(() => {
    const row = rowRef.current;
    // Центральная колонка (section → stage-overlay → column): её высота стабильна
    // (flex-1 + min-h-0, не зависит от размера сцены) — берём её как доступную
    // высоту, чтобы квадрат всегда влезал без вертикального скролла.
    const col = sectionRef.current?.parentElement?.parentElement ?? null;
    if (!row) return;
    const measure = () => {
      const rowW = row.clientWidth;
      if (rowW === 0) return; // скрыто
      // В полноэкранном режиме секция (sectionRef) сама занимает вьюпорт, а её
      // родительская колонка остаётся «страничной» высоты — поэтому меряем по
      // самой секции (padding-box уже учитывает [&:fullscreen]:p-6).
      const section = sectionRef.current;
      const fs = !!section && document.fullscreenElement === section;
      // На ≥sm рельс слева + балансирующий спейсер справа той же ширины (чтобы
      // квадрат стоял ровно по центру, на одной оси с заголовком): 2×(46+12).
      const wide = window.innerWidth >= 640;
      const availW = Math.max(120, rowW - (wide ? 116 : 0));
      // Обычный режим: высота колонки (flex-1) уже учитывает нижний резерв под
      // док/кружки — <main> держит pb-40; вычитаем только верхнюю панель (~64).
      // Fullscreen: берём высоту самой секции (минус небольшой зазор сверху/снизу).
      const colH = col?.clientHeight ?? window.innerHeight;
      const availH = fs ? Math.max(240, section!.clientHeight - 16) : Math.max(240, colH - 64);
      let w = availW;
      let h = w / ar;
      if (h > availH) {
        h = availH;
        w = h * ar;
      }
      setBox({ w: Math.round(w), h: Math.round(h) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    if (col) ro.observe(col);
    window.addEventListener("resize", measure);
    document.addEventListener("fullscreenchange", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("fullscreenchange", measure);
    };
  }, [ar]);

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
          objects: objectsRef.current,
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
        case "gobj-add": {
          const e = sanitizeClock(msg.epoch);
          if (e === null || e < epochRef.current) break;
          if (e > epochRef.current) catchUpEpoch(e);
          const obj = sanitizeGameObject(msg.obj);
          if (!obj) break;
          // upsert по id: и создание, и правка типа/техники/заметки/геометрии.
          setObjects((prev) => {
            const i = prev.findIndex((o) => o.id === obj.id);
            if (i !== -1) {
              const n = prev.slice();
              n[i] = obj;
              return n;
            }
            if (prev.length >= MAX_OBJECTS) return prev; // потолок
            return [...prev, obj];
          });
          break;
        }
        case "gobj-move": {
          const e = sanitizeClock(msg.epoch);
          if (e === null || e < epochRef.current) break;
          if (e > epochRef.current) {
            catchUpEpoch(e);
            break;
          }
          if (typeof msg.id !== "string") break;
          // Патч геометрии: применяем только присутствующие конечные поля. Если
          // объекта с таким id ещё нет — игнор (создать из move нельзя: нет kind).
          const g: ObjGeom = {};
          if (Number.isFinite(msg.x)) g.x = msg.x as number;
          if (Number.isFinite(msg.y)) g.y = msg.y as number;
          if (Number.isFinite(msg.fromX)) g.fromX = msg.fromX as number;
          if (Number.isFinite(msg.fromY)) g.fromY = msg.fromY as number;
          if (Number.isFinite(msg.radius)) g.radius = msg.radius as number;
          setObjects((prev) => prev.map((o) => (o.id === msg.id ? applyGeom(o, g) : o)));
          break;
        }
        case "gobj-del": {
          const e = sanitizeClock(msg.epoch);
          if (e === null || e < epochRef.current) break;
          if (e > epochRef.current) catchUpEpoch(e); // пропустили «Очистить» — догоняем
          if (typeof msg.id !== "string") break;
          setObjects((prev) => prev.filter((o) => o.id !== msg.id));
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
              arrowsRef.current.length > 0 ||
              objectsRef.current.length > 0)
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
          // Объекты из снапшота — слияние по id (не старее нашей последней очистки).
          if (msg.objects && e !== null && e >= epochRef.current) {
            const incoming = sanitizeGameObjects(msg.objects);
            setObjects((prev) => {
              const byId = new Map(prev.map((o) => [o.id, o]));
              for (const o of incoming) {
                if (byId.size < MAX_OBJECTS || byId.has(o.id)) byId.set(o.id, o);
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
      if (objRafRef.current != null) cancelAnimationFrame(objRafRef.current);
    };
  }, []);

  // --- Фигурки: добавление, правка подписи, перемещение, удаление ---
  // Ставим фигурку по КЛИКУ на доске (а не сразу в центр): рельс лишь «заряжает»
  // команду (pendingTeam), следующий клик по сцене кладёт фишку в это место.
  const addFigure = useCallback(
    (team: Team, x: number, y: number) => {
      // id берём вне апдейтера (счётчик растёт один раз). Номер считаем ВНУТРИ по
      // актуальному prev — иначе два быстрых клика подряд (ref ещё не обновлён
      // эффектом) дали бы одинаковый номер. fig-add идемпотентен по id, поэтому
      // повторный вызов апдейтера в StrictMode не плодит дублей у получателей.
      const id = genFigureId(`${identityRef.current}.${mountTag.current}`, figSeq.current++);
      setFigures((prev) => {
        if (prev.length >= MAX_FIGURES) return prev;
        const fig: Figure = { id, team, label: String(nextFigureNumber(prev, team)), x: clamp01(x), y: clamp01(y) };
        broadcast({ t: "fig-add", epoch: epochRef.current, fig });
        return [...prev, fig];
      });
    },
    [broadcast],
  );

  // Команда CT/T работает как обычный инструмент: нажал — ставишь фишки кликами
  // сколько нужно; нажал ту же команду ещё раз — выключился. Включаем режим
  // «Перемещение», чтобы клики по пустому месту доходили до холста (в «Стрелке»
  // их перехватил бы слой стрелок). Снимаем выделение при включении.
  const armFigure = useCallback((team: Team) => {
    if (pendingTeam === team) {
      setPendingTeam(null); // повторное нажатие выключает инструмент фишки
      return;
    }
    setPendingTeam(team);
    setTool("move");
    setSelectedFigId(null);
    setSelectedArrowId(null);
    setSelectedObjId(null);
  }, [pendingTeam]);

  // Выбор инструмента из рельса снимает «заряженную» команду постановки.
  const chooseTool = useCallback((t: Tool) => {
    setTool(t);
    setPendingTeam(null);
  }, []);

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
        size: arrowSize,
        ...g,
      };
      setArrows((prev) => (prev.length >= MAX_ARROWS ? prev : [...prev, arrow]));
      broadcast({ t: "arrow-add", epoch: epochRef.current, arrow });
    },
    [broadcast, color, arrowStyle, arrowSize],
  );

  const deleteArrow = useCallback(
    (id: string) => {
      setArrows((prev) => prev.filter((a) => a.id !== id));
      setSelectedArrowId((cur) => (cur === id ? null : cur));
      broadcast({ t: "arrow-del", epoch: epochRef.current, id });
    },
    [broadcast],
  );

  // --- Игровые объекты: добавление, геометрия (драг), правка, удаление ---
  const addObject = useCallback(
    (kind: ObjKind, x: number, y: number) => {
      // Потолок проверяем ДО рассылки: иначе на пределе локально объект не
      // добавится, а gobj-add всё равно улетит (пир ниже своего лимита его
      // вставит → расхождение) и выделение укажет на несуществующий id.
      if (objectsRef.current.length >= MAX_OBJECTS) return;
      const id = genObjectId(`${identityRef.current}.${mountTag.current}`, objSeq.current++);
      const def = objDef(kind);
      const obj: GameObject = { id, kind, x, y };
      if (def.cls === "zone") obj.radius = objRadii[kind] ?? def.defaultRadius;
      setObjects((prev) => (prev.length >= MAX_OBJECTS ? prev : [...prev, obj]));
      broadcast({ t: "gobj-add", epoch: epochRef.current, obj });
      // Выделение взаимоисключающее: ставим объект — снимаем фигурку/стрелку.
      setSelectedObjId(id);
      setSelectedFigId(null);
      setSelectedArrowId(null);
    },
    [broadcast, objRadii],
  );

  // Живой драг: батч-патч на кадр (как fig-move) — и локально, и по сети.
  const flushObjMoves = useCallback(() => {
    objRafRef.current = null;
    const pending = objMovePending.current;
    if (pending.size === 0) return;
    setObjects((prev) => prev.map((o) => (pending.has(o.id) ? applyGeom(o, pending.get(o.id)!) : o)));
    for (const [id, g] of pending) {
      broadcast({ t: "gobj-move", epoch: epochRef.current, id, ...g });
    }
    pending.clear();
  }, [broadcast]);

  const objGeomLive = useCallback(
    (id: string, g: ObjGeom) => {
      const cur = objMovePending.current.get(id) ?? {};
      objMovePending.current.set(id, { ...cur, ...g });
      if (objRafRef.current == null) objRafRef.current = requestAnimationFrame(flushObjMoves);
    },
    [flushObjMoves],
  );

  // Коммит финальной геометрии: применяем к объекту и шлём авторитетный gobj-add.
  const objGeomCommit = useCallback(
    (id: string, g: ObjGeom) => {
      objMovePending.current.delete(id);
      const cur = objectsRef.current.find((o) => o.id === id);
      if (!cur) return;
      const next = applyGeom(cur, g);
      setObjects((prev) => prev.map((o) => (o.id === id ? next : o)));
      broadcast({ t: "gobj-add", epoch: epochRef.current, obj: next });
    },
    [broadcast],
  );

  const editObject = useCallback(
    (id: string, patch: { technique?: Technique; note?: string }) => {
      const cur = objectsRef.current.find((o) => o.id === id);
      if (!cur) return;
      const next: GameObject = { ...cur };
      if ("technique" in patch) next.technique = patch.technique;
      if ("note" in patch) {
        const n = safeNote(patch.note);
        next.note = n || undefined;
      }
      setObjects((prev) => prev.map((o) => (o.id === id ? next : o)));
      broadcast({ t: "gobj-add", epoch: epochRef.current, obj: next });
    },
    [broadcast],
  );

  const deleteObject = useCallback(
    (id: string) => {
      setObjects((prev) => prev.filter((o) => o.id !== id));
      setSelectedObjId((cur) => (cur === id ? null : cur));
      broadcast({ t: "gobj-del", epoch: epochRef.current, id });
    },
    [broadcast],
  );

  const selectObject = useCallback((id: string | null) => {
    setSelectedObjId(id);
    if (id !== null) { setSelectedFigId(null); setSelectedArrowId(null); }
  }, []);

  // Снять выделение со всех слоёв. Вызывается с холста (он лежит под слоями
  // фигурок/стрелок/объектов): клик по пустому месту в режиме «Перемещение»
  // проваливается на холст, т.к. корни слоёв сквозные (pointer-events:none).
  const deselectAll = useCallback(() => {
    setSelectedFigId(null);
    setSelectedArrowId(null);
    setSelectedObjId(null);
  }, []);

  // Выделение фигурки, стрелки и объекта взаимоисключающее: выбор одного снимает
  // остальные, иначе по Delete удалялась бы лишь фигурка, а прочее «залипало».
  const selectFigure = useCallback((id: string | null) => {
    setSelectedFigId(id);
    if (id !== null) { setSelectedArrowId(null); setSelectedObjId(null); }
  }, []);
  const selectArrow = useCallback((id: string | null) => {
    setSelectedArrowId(id);
    if (id !== null) { setSelectedFigId(null); setSelectedObjId(null); }
  }, []);

  // Delete/Backspace удаляет выделенную фигурку, стрелку или объект (если фокус не в поле ввода).
  useEffect(() => {
    if (!active || (!selectedFigId && !selectedArrowId && !selectedObjId)) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Delete" && ev.key !== "Backspace") return;
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      ev.preventDefault();
      if (selectedFigId) deleteFigure(selectedFigId);
      else if (selectedArrowId) deleteArrow(selectedArrowId);
      else if (selectedObjId) deleteObject(selectedObjId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, selectedFigId, selectedArrowId, selectedObjId, deleteFigure, deleteArrow, deleteObject]);

  // Горячие клавиши инструментов (Q/W/E/A/G). Коды клавиш (e.code, не зависят от
  // раскладки) подобраны бесконфликтно с голосовыми биндами (M/D/S/V/Digit2).
  // Активны только когда доска видима и фокус не в поле ввода.
  useEffect(() => {
    if (!active) return;
    const TOOL_KEYS: Record<string, Tool> = {
      KeyQ: "move", KeyW: "draw", KeyE: "erase", KeyA: "arrow", KeyG: "nade",
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (ev.code === "Escape") { setPendingTeam(null); return; } // отменить постановку фишки
      const t = TOOL_KEYS[ev.code];
      if (!t) return;
      ev.preventDefault();
      setTool(t);
      setPendingTeam(null); // смена инструмента снимает «заряженную» команду
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  // --- Ввод указателем ---
  const pointFromEvent = useCallback((e: React.PointerEvent): Point => {
    return normToRect(e.clientX, e.clientY, canvasRef.current!.getBoundingClientRect());
  }, []);

  function handlePointerDown(e: React.PointerEvent) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    // Заряжена команда — ставим фишку в точку клика. Заряд НЕ снимаем: как обычный
    // инструмент, ставим сколько нужно (выключается повторным кликом по CT/T или Esc).
    if (pendingTeam) {
      const [x, y] = pointFromEvent(e);
      addFigure(pendingTeam, x, y);
      return;
    }
    // Холст лежит под слоями объектов/стрелок/фигурок и в этих режимах ловит
    // только клики по ПУСТОМУ месту (по элементам слоёв указатель перехватывают
    // сами элементы). Граната — поставить; перемещение — снять выделение.
    if (tool === "nade") {
      const [x, y] = pointFromEvent(e);
      addObject(objKind, x, y);
      return;
    }
    if (tool === "move") {
      deselectAll();
      return;
    }
    if (tool !== "draw" && tool !== "erase") return; // дальше — только кисть/ластик
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
  function changeArrowSize(v: number) {
    const s = clampArrowSize(v);
    setArrowSize(s);
    debouncedSave("arrowSize", () => saveBoardArrowSize(s));
  }
  // Радиус: задаёт дефолт для новых гранат активного типа И, если выбран
  // zone-объект, двигает его радиус вживую (штатный коммит → синхрон по сети).
  function changeObjRadius(r: number) {
    const clamped = clampRadius(r);
    const next = { ...objRadii, [objKind]: clamped };
    setObjRadii(next);
    debouncedSave("objRadii", () => saveBoardObjRadii(next as Record<string, number>));
    // Радиус правим только у zone-объекта; у icon-объекта (флеш/дэкой) его нет.
    if (selectedObjId) {
      const sel = objectsRef.current.find((o) => o.id === selectedObjId);
      if (sel && objClass(sel.kind) === "zone") objGeomCommit(selectedObjId, { radius: clamped });
    }
  }
  // Цвет команды — локально (только заливка base), персист в localStorage.
  function changeTeamColor(team: Team, base: string) {
    const next = { ...teamBase, [team]: base };
    setTeamBase(next);
    debouncedSave("teamColors", () => saveTeamColors(next));
  }
  // Курсор над сценой: позиционируем кольцо-превью императивно (через ref + rAF),
  // без setState — это горячий путь рисования. Кольцо нужно только для кисти/
  // ластика и zone-гранаты; иначе прячем.
  function trackCursor(e: React.PointerEvent) {
    const ringEl = cursorRingRef.current;
    if (!ringEl) return;
    const showRing = tool === "draw" || tool === "erase" || (tool === "nade" && objClass(objKind) === "zone");
    if (!showRing) {
      ringEl.style.display = "none";
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (cursorRaf.current != null) cancelAnimationFrame(cursorRaf.current);
    cursorRaf.current = requestAnimationFrame(() => {
      ringEl.style.display = "block";
      ringEl.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    });
  }
  function hideCursorRing() {
    if (cursorRaf.current != null) cancelAnimationFrame(cursorRaf.current);
    if (cursorRingRef.current) cursorRingRef.current.style.display = "none";
  }
  function clearBoard() {
    epochRef.current += 1; // новая эпоха — отбрасывает поздние/повторные старые штрихи
    strokesRef.current = [];
    activeRef.current = null;
    setFigures([]);
    setArrows([]);
    setObjects([]);
    setSelectedFigId(null);
    setSelectedArrowId(null);
    setSelectedObjId(null);
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
    setMoreOpen(false);
  }

  // Доску — на весь экран (сама секция, чтобы рельс с инструментами остался).
  function toggleFullscreen() {
    const el = sectionRef.current;
    if (!document.fullscreenElement) el?.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
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

  // Кольцо-превью у курсора: кисть/ластик → диаметр = толщина линии в CSS-px;
  // zone-граната → диаметр зоны. Прочие инструменты — без кольца. Геометрия зависит
  // от инструмента/размера/ширины сцены (box.w), но НЕ от позиции курсора — её
  // считаем через useMemo, а позицию двигаем императивно (см. trackCursor).
  const objRadiusValue = objRadii[objKind] ?? objDef(objKind).defaultRadius ?? 0.05;
  const ring = useMemo(() => {
    const w = box.w;
    if (w <= 0) return null;
    if (tool === "draw" || tool === "erase") {
      const d = Math.max(2, (size / NOMINAL_WIDTH) * w);
      return { d, color: tool === "erase" ? "var(--text-dim)" : color, fill: "transparent" };
    }
    if (tool === "nade" && objClass(objKind) === "zone") {
      const c = objDef(objKind).color;
      return { d: 2 * objRadiusValue * w, color: c, fill: `${c}33` };
    }
    return null;
  }, [box.w, tool, size, color, objKind, objRadiusValue]);

  // Применяем геометрию кольца к элементу при её смене; позицию НЕ трогаем (её
  // двигает trackCursor). Когда кольцо не нужно — прячем.
  useEffect(() => {
    const el = cursorRingRef.current;
    if (!el) return;
    if (!ring) {
      el.style.display = "none";
      return;
    }
    el.style.width = `${ring.d}px`;
    el.style.height = `${ring.d}px`;
    el.style.border = `1.5px solid ${ring.color}`;
    el.style.background = ring.fill;
  }, [ring]);

  return (
    // Фон секции — только в полноэкранном режиме; в обычном пусть просвечивает
    // градиент страницы (без сплошного чёрного прямоугольника вокруг доски).
    <section ref={sectionRef} className="flex flex-col gap-3 [&:fullscreen]:items-center [&:fullscreen]:justify-center [&:fullscreen]:bg-bg [&:fullscreen]:p-6">
      {uploadError && <Banner tone="warn">{uploadError}</Banner>}

      {/* Рельс + сцена центрируются как единый кластер — рельс вплотную к квадрату,
          без пустоты между ними. На узких экранах рельс складывается над доской. */}
      <div ref={rowRef} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-center">
        <BoardRail
          tool={tool}
          onTool={chooseTool}
          color={color}
          onColor={pickColor}
          size={size}
          minSize={MIN_SIZE}
          maxSize={MAX_SIZE}
          onSize={changeSize}
          arrowStyle={arrowStyle}
          onArrowStyle={setArrowStyle}
          arrowSize={arrowSize}
          onArrowSize={changeArrowSize}
          objKind={objKind}
          onObjKind={setObjKind}
          objRadius={objRadiusValue}
          onObjRadius={changeObjRadius}
          teamColors={teamColors}
          onTeamColor={changeTeamColor}
          pendingTeam={pendingTeam}
          onArmFigure={armFigure}
          onClear={clearBoard}
        />

        {/* Правая колонка: верхняя панель (ровно по ширине квадрата) + сцена.
            На ≥sm колонка сжимается до ширины квадрата (sm:w-auto), кластер центрируется. */}
        <div className="flex w-full min-w-0 flex-col gap-3 sm:w-auto">
          {/* Панель управления картой — только хост. relative z-30 — иначе её
              выпадашки (выбор карты, «Ещё») уходят за крупную сцену. */}
          {amHost && (
            <div
              className="relative z-30 flex w-full items-center gap-1 rounded-[var(--radius)] border border-border bg-surface/80 px-1.5 py-1 text-[13px] backdrop-blur"
              style={{ width: box.w || undefined }}
            >
              <MapPicker currentSrc={bg} onPick={(m: GameMap) => setBackground(m.src)} />
              <div className="flex-1" />
              <label className="btn btn--sm h-8 cursor-pointer gap-1.5 px-2.5 text-[13px] font-medium" title="Загрузить карту">
                <UploadIcon />
                <span className="hidden md:inline">{uploading ? "Загрузка…" : "Загрузить карту"}</span>
                <input type="file" accept="image/*" onChange={handleUpload} disabled={uploading} className="hidden" />
              </label>
              <IconBtn title="На весь экран" onClick={toggleFullscreen}>
                <FullscreenIcon />
              </IconBtn>
              <div className="relative" ref={moreRef}>
                <IconBtn title="Ещё" onClick={() => setMoreOpen((v) => !v)} active={moreOpen}>
                  <Icon name="dots" size={18} />
                </IconBtn>
                {moreOpen && (
                    <div className="absolute right-0 top-full z-50 mt-1 flex w-72 flex-col gap-2 rounded-[var(--radius)] border border-border-strong bg-surface-2 p-2 shadow-[var(--shadow-2)]">
                      <input
                        value={urlInput}
                        onChange={(e) => setUrlInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && applyUrlBg()}
                        placeholder="Ссылка на картинку"
                        className="field w-full"
                      />
                      <div className="flex gap-2">
                        <button onClick={applyUrlBg} className="btn btn--sm btn--primary flex-1">Применить</button>
                        {bg && (
                          <button onClick={() => { setBackground(null); setMoreOpen(false); }} className="btn btn--sm">
                            Убрать фон
                          </button>
                        )}
                      </div>
                    </div>
                )}
              </div>
            </div>
          )}

          <div className="flex justify-center">
          <div
            ref={containerRef}
            className="stage relative max-w-full"
            style={{ width: box.w || "100%", height: box.h || undefined, aspectRatio: box.w ? undefined : String(bgAspect ?? DEFAULT_ASPECT) }}
            onPointerMove={trackCursor}
            onPointerLeave={hideCursorRing}
          >
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
            // Холст ловит указатель во всех режимах, КРОМЕ «Стрелки» (там слой
            // стрелок рисует резиновую прямую). В «Перемещении» он нужен для снятия
            // выделения по пустому месту, в «Гранате» — для постановки.
            "absolute inset-0 h-full w-full touch-none " +
            (pendingTeam
              ? "cursor-crosshair"
              : tool === "arrow"
                ? "pointer-events-none"
                : tool === "move"
                  ? "cursor-default"
                  : "cursor-crosshair")
          }
        />
        <GObjectLayer
          objects={objects}
          draggable={tool === "move"}
          selectedId={selectedObjId}
          onSelect={selectObject}
          onGeom={objGeomLive}
          onGeomEnd={objGeomCommit}
          onEdit={editObject}
          onDelete={deleteObject}
        />
        <ArrowLayer
          arrows={arrows}
          drawing={tool === "arrow"}
          selecting={tool === "move"}
          color={color}
          style={arrowStyle}
          size={arrowSize}
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
          teamColors={teamColors}
        />
        {/* Кольцо-превью у курсора (толщина кисти/радиус зоны) — чисто визуально.
            Всегда смонтировано, скрыто по умолчанию; позицию/геометрию пишем через
            ref (без ре-рендера на каждое движение мыши). */}
        <div
          ref={cursorRingRef}
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 rounded-full"
          style={{ display: "none" }}
        />
        </div>
        </div>
        </div>
        {/* Балансир справа — той же ширины, что и рельс слева: квадрат встаёт
            ровно по центру, на одной оси с заголовком комнаты. */}
        <div className="hidden w-[46px] shrink-0 sm:block" aria-hidden />
      </div>
    </section>
  );
}

/** Компактная иконка-кнопка верхней панели (36px, как в рельсе). */
function IconBtn({
  title, onClick, active, children,
}: {
  title: string; onClick: () => void; active?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={
        "flex h-8 w-8 items-center justify-center rounded-lg transition-colors " +
        (active ? "bg-surface text-text" : "text-text-dim hover:bg-surface hover:text-text")
      }
    >
      {children}
    </button>
  );
}

function UploadIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5-5 5 5" />
      <path d="M12 5v12" />
    </svg>
  );
}

function FullscreenIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}
