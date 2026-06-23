// Небольшой баннер-уведомление. Раньше эта разметка дублировалась в нескольких
// местах (переподключение, нет микрофона, ошибка экрана, ошибка загрузки карты);
// собрали в один компонент с тоном warn/error, чтобы стиль не расходился.

const TONE = {
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  error: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
} as const;

export default function Banner({
  tone = "warn",
  children,
}: {
  tone?: keyof typeof TONE;
  children: React.ReactNode;
}) {
  return (
    <p role="alert" className={`rounded-md px-3 py-2 text-sm ${TONE[tone]}`}>
      {children}
    </p>
  );
}
