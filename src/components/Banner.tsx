// Небольшой баннер-уведомление. Раньше разметка дублировалась в нескольких
// местах (переподключение, нет микрофона, ошибка экрана, ошибка загрузки карты);
// собрали в один компонент. Тон задаёт цвет + иконку: цвет никогда не один
// (требование доступности — colorblind-safe), всегда продублирован значком.

import Icon, { type IconName } from "./Icon";

const TONE: Record<string, { cls: string; icon: IconName }> = {
  warn: { cls: "banner--warn", icon: "ban" },
  error: { cls: "banner--error", icon: "ban" },
  info: { cls: "banner--info", icon: "check" },
} as const;

export default function Banner({
  tone = "warn",
  children,
}: {
  tone?: keyof typeof TONE;
  children: React.ReactNode;
}) {
  const t = TONE[tone];
  return (
    <p role="alert" className={`banner ${t.cls}`}>
      <Icon name={t.icon} size={18} className="banner-ic" />
      <span>{children}</span>
    </p>
  );
}
