import { CaretRight } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { useFindForce } from "../lib/chat-find";
import { plural, t } from "../lib/i18n";
import type { Block, ToolName } from "../lib/types";
import { Disclosure } from "./Disclosure";
import { ActionRow, runningVerb } from "./Blocks";
import { Counter } from "@maxhub/max-ui";

type Action = Extract<Block, { kind: "action" }>;

/** While a group is running only its newest rows are drawn; the rest wait behind «ещё N». */
export const LIVE_LIMIT = 30;

const searchable = (b: Action) => [b.title, b.detail, b.output, b.result].filter(Boolean).join("\n");

/**
 * Consecutive tool calls as one line: short categories («Прочитал 2 файла, выполнил команду»),
 * running and failed counts. It opens on its own while something runs or fails, but once open it stays open
 * until the learner closes it, however the group changes afterwards. Opening shows the original rows.
 */
export function ToolGroup({ blocks }: { blocks: Action[] }) {
  const running = blocks.filter((b) => b.state === "running").length;
  const fails = blocks.filter((b) => b.state === "error" && b.output !== "Прервано").length;
  const [user, setUser] = useState<boolean | undefined>(undefined);
  const auto = useRef(false);
  if (running > 0 || fails > 0) auto.current = true;
  const found = useFindForce(...blocks.map(searchable));
  const open = user ?? true; // показываем инструменты, детали строк раскрываются отдельно

  const done = (tool: ToolName) => blocks.filter((b) => b.tool === tool && b.state === "done").length;
  const parts = [
    done("read") && t("прочитал {0} {1}", [done("read"), plural(done("read"), t("файл"), t("файла"), t("файлов"))]),
    done("bash") && t("выполнил {0}", [done("bash") === 1 ? t("команду") : `${done("bash")} ${plural(done("bash"), t("команду"), t("команды"), t("команд"))}`]),
    done("web_search") && t("искал в сети{0}", [done("web_search") > 1 ? ` ×${done("web_search")}` : ""]),
    done("web_read") && t("открыл {0} {1}", [done("web_read"), plural(done("web_read"), t("страницу"), t("страницы"), t("страниц"))]),
    done("researcher") && t("запускал исследователя"),
    done("skill") && t("загрузил навык"),
  ].filter(Boolean) as string[];
  if (parts.length) parts[0] = parts[0][0].toUpperCase() + parts[0].slice(1);

  const failOnly = running === 0 && parts.length === 0 && fails > 0;
  const failWord = `${fails} ${plural(fails, t("сбой"), t("сбоя"), t("сбоев"))}`;
  const live = [...blocks].reverse().find((b) => b.state === "running");
  const summary = failOnly ? failWord : parts.join(", ");
  const liveVerb = live ? t(runningVerb(live.tool)) : "";

  const clipped = running > 0 && blocks.length > LIVE_LIMIT && !found; // a search shows every row, so matches are never hidden
  const shown = clipped ? blocks.slice(-LIVE_LIMIT) : blocks;
  return (
    <div className="tool-group" data-no-ripple data-running={running > 0 ? "" : undefined} data-failed={fails > 0 ? "" : undefined}>
      <button type="button" className="trace" aria-expanded={open} onClick={() => setUser(!open)} aria-label={[`${blocks.length} ${plural(blocks.length, t("действие"), t("действия"), t("действий"))}: ${summary || liveVerb}`, running > 0 && t("идёт {0}", [running]), fails > 0 && !failOnly && failWord].filter(Boolean).join(", ")}>
        {summary && <span className="trace-verb">{summary}</span>}
        {liveVerb && summary && <span className="trace-result">·</span>}
        {liveVerb && <span className="trace-verb shimmer-text">{liveVerb}</span>}
        {running > 1 && <span className="trace-result">· {t("идёт {0}", [running])}</span>}
        {fails > 0 && !failOnly && <span className="trace-result text-warn-ui">· {failWord}</span>}
        {parts.length > 1 && <Counter className="tool-group-count" value={blocks.length} variant="mute" rounded aria-hidden="true" />}
        <CaretRight aria-hidden="true" className="trace-chev" />
      </button>
      <Disclosure open={open}>
        <div className="trace-list">
          {clipped && <span className="tool-group-more">{t("ещё {0} действий выше", [blocks.length - LIVE_LIMIT])}</span>}
          {shown.map((b) => (
            <ActionRow key={b.id} block={b} />
          ))}
        </div>
      </Disclosure>
    </div>
  );
}
