import type { KeyboardEvent, Ref } from "react";
import { Check } from "lucide-react";
import type { ThemeAppearance, ThemeId } from "../themes";

// A miniature Athena window. data-theme scopes that theme's tokens onto this
// subtree (tokens are declared on every [data-theme] element), so the preview
// is the real theme, not a hand-maintained swatch.
export function ThemeMiniWindow({ theme, className = "" }: { theme: ThemeId; className?: string }) {
  return (
    <div className={className ? `themeMiniWindow ${className}` : "themeMiniWindow"} data-theme={theme} aria-hidden="true">
      <div className="themeMiniTitle">
        <i />
        <i />
        <i />
        <span className="themeMiniNav" />
      </div>
      <div className="themeMiniBody">
        <div className="themeMiniSidebar">
          <span className="active" />
          <span />
          <span />
        </div>
        <div className="themeMiniPane">
          <div className="themeMiniPaneHead">
            <span className="themeMiniType">Aa</span>
            <span className="themeMiniAccent" />
          </div>
          <div className="themeMiniTerminal">
            <span><b className="ansiGreen" style={{ width: "34%" }} /><b className="ansiMuted" style={{ width: "28%" }} /></span>
            <span><b className="ansiBlue" style={{ width: "52%" }} /></span>
            <span><b className="ansiYellow" style={{ width: "22%" }} /><b className="ansiMuted" style={{ width: "36%" }} /></span>
            <span><b className="ansiText" style={{ width: "44%" }} /><b className="ansiCursor" /></span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ThemePreviewCard({
  label,
  description,
  appearance,
  selected,
  preview,
  tag,
  cardRef,
  onSelect,
  onKeyDown,
}: {
  label: string;
  description: string;
  appearance: ThemeAppearance | "auto";
  selected: boolean;
  // A single theme, or the dark/light pair "Match system" resolves to.
  preview: ThemeId | { dark: ThemeId; light: ThemeId };
  tag?: string;
  cardRef?: Ref<HTMLButtonElement>;
  onSelect: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      ref={cardRef}
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      className={selected ? "themeCard selected" : "themeCard"}
      title={description}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <span className="themeCardPreview">
        {typeof preview === "string" ? (
          <ThemeMiniWindow theme={preview} />
        ) : (
          <span className="themeCardSplit">
            <ThemeMiniWindow theme={preview.dark} className="half dark" />
            <ThemeMiniWindow theme={preview.light} className="half light" />
          </span>
        )}
        {selected && (
          <span className="themeCardCheck" aria-hidden="true">
            <Check size={12} strokeWidth={3} />
          </span>
        )}
      </span>
      <span className="themeCardCaption">
        <span className="themeCardTitle">
          <strong>{label}</strong>
          <em className={`themeCardTag ${appearance}`}>{tag ?? (appearance === "auto" ? "Auto" : appearance === "light" ? "Light" : "Dark")}</em>
        </span>
        <small>{description}</small>
      </span>
    </button>
  );
}
