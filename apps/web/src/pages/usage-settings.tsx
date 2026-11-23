import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { UsageCell, UsagePeriod } from "@tangow/contracts";
import {
  formatTokenCount,
  pivotUsage,
  type UsageAverage,
  type UsageCategoryKey,
  type UsageDimension,
  type UsageFocus,
  type UsageRow,
  usageAverage,
  usageDimensions,
} from "@tangow/core";
import { BotAvatar, SegmentedControl, SettingRow, ShareBar, shareBarInk } from "@tangow/ui-web";
import { ChevronLeft } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

/** Settings › Usage: spend by bot, model and category, input and output always apart. */
export function UsageSettingsPanel({ panelRef }: { panelRef?: RefObject<HTMLDivElement | null> }) {
  const { t, i18n } = useLingui();
  const [period, setPeriod] = useState<UsagePeriod>("30d");
  const [cells, setCells] = useState<UsageCell[] | null>(null);
  const [focus, setFocus] = useState<(UsageFocus & { row: UsageRow }) | null>(null);
  const [dimension, setDimension] = useState<UsageDimension>("bots");

  useEffect(() => {
    let current = true;
    // A failed fetch must not leave another period's figures under this one.
    setCells(null);
    void rpc.usage
      .breakdown({ period })
      .then((next) => {
        if (current) setCells(next);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [period]);

  const tokens = (value: number) => formatTokenCount(value, i18n.locale);
  const categoryLabel = (category: UsageCategoryKey) =>
    ({
      fast: t`Fast`,
      everyday: t`Everyday`,
      complex: t`Complex`,
      fixed: t`Fixed`,
      compaction: t`Compaction`,
      unrecorded: t`Not recorded`,
    })[category];
  const rowLabel = (row: UsageRow, by: UsageDimension) =>
    by === "bots"
      ? (row.bot?.name ?? t`Deleted bot`)
      : by === "models"
        ? row.model
        : categoryLabel(row.category);
  const average = (value: UsageAverage) =>
    value.per === "run"
      ? t`${plural(value.count, { one: "# run", other: "# runs" })} · ${tokens(value.inputTokens)} in · ${tokens(value.outputTokens)} out / run`
      : t`${plural(value.count, { one: "# compaction", other: "# compactions" })} · ${tokens(value.inputTokens)} in · ${tokens(value.outputTokens)} out / compaction`;

  const dimensions = usageDimensions(focus);
  const shown = dimensions.includes(dimension) ? dimension : dimensions[0]!;
  const { totals, rows } = pivotUsage(cells ?? [], shown, focus);
  const tabLabels: Record<UsageDimension, string> = {
    bots: t`Bots`,
    models: t`Models`,
    categories: t`Categories`,
  };

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      data-testid="usage-settings"
      className="flex flex-col gap-3 outline-none"
    >
      <div className="flex min-h-8 items-center justify-between gap-3">
        {focus ? (
          <button
            type="button"
            onClick={() => setFocus(null)}
            className="-ms-1 flex min-w-0 items-center gap-1.5 rounded-row px-1 text-title text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={t`Back to all usage`}
          >
            <ChevronLeft
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground rtl:-scale-x-100"
            />
            <span className="truncate">{rowLabel(focus.row, focus.dimension)}</span>
          </button>
        ) : null}
        <SegmentedControl<UsagePeriod>
          className="ms-auto"
          aria-label={t`Period`}
          value={period}
          onValueChange={setPeriod}
          options={[
            { value: "7d", label: t`7d` },
            { value: "30d", label: t`30d` },
            { value: "all", label: t`All` },
          ]}
        />
      </div>

      {cells && rows.length === 0 ? (
        <p className="rounded-card bg-group px-4 py-4 text-meta text-muted-foreground shadow-group">
          <Trans>No usage in this period.</Trans>
        </p>
      ) : null}

      {rows.length > 0 ? (
        <>
          <section
            data-testid="usage-totals"
            className="flex flex-col gap-2 rounded-card bg-group px-4 py-4 shadow-group"
          >
            <p className="flex items-baseline gap-5 text-question text-foreground tabular-nums">
              <span>
                <Trans>
                  {tokens(totals.inputTokens)}{" "}
                  <span className="text-meta text-muted-foreground">in</span>
                </Trans>
              </span>
              <span>
                <Trans>
                  {tokens(totals.outputTokens)}{" "}
                  <span className="text-meta text-muted-foreground">out</span>
                </Trans>
              </span>
            </p>
            <p className="flex flex-wrap gap-x-4 text-meta text-muted-foreground tabular-nums">
              {totals.runs.count > 0 ? <span>{average(usageAverage(totals)!)}</span> : null}
              {totals.compactions.count > 0 ? (
                <span>
                  {t`${plural(totals.compactions.count, { one: "# compaction", other: "# compactions" })} · ${tokens(totals.compactions.inputTokens)} in · ${tokens(totals.compactions.outputTokens)} out`}
                </span>
              ) : null}
            </p>
            <ShareBar
              className="mt-1"
              segments={rows.map((row) => ({
                key: row.key,
                value: row.inputTokens + row.outputTokens,
                color: shown === "bots" ? (row.bot?.color ?? null) : null,
              }))}
            />
          </section>

          <SegmentedControl<UsageDimension>
            aria-label={t`Breakdown`}
            className="flex w-full"
            value={shown}
            onValueChange={setDimension}
            options={dimensions.map((value) => ({ value, label: tabLabels[value] }))}
          />

          <div
            data-testid="usage-rows"
            className="overflow-hidden rounded-card bg-group shadow-group"
          >
            {rows.map((row, index) => {
              const rowAverage = usageAverage(row);
              return (
                <SettingRow
                  key={row.key}
                  className={index > 0 ? "border-t border-border" : undefined}
                  leading={
                    shown === "bots" ? (
                      row.bot && !row.bot.deleted ? (
                        <BotAvatar character={row.bot.avatarCharacter} size={28} />
                      ) : (
                        <span
                          aria-hidden
                          className="size-7 shrink-0 rounded-full bg-foreground-subtle"
                        />
                      )
                    ) : (
                      <span
                        aria-hidden
                        className={`size-2.5 shrink-0 rounded-full ${shareBarInk(index)}`}
                      />
                    )
                  }
                  label={
                    <span className={shown === "models" ? "font-mono text-mono" : undefined}>
                      {rowLabel(row, shown)}
                      {shown === "bots" && row.bot?.deleted ? (
                        <span className="ms-2 text-meta text-muted-foreground">
                          <Trans>Deleted</Trans>
                        </span>
                      ) : null}
                    </span>
                  }
                  subline={rowAverage ? average(rowAverage) : undefined}
                  value={
                    <>
                      <span className="text-foreground">{t`${tokens(row.inputTokens)} in`}</span>
                      <span>{t`${tokens(row.outputTokens)} out`}</span>
                    </>
                  }
                  chevron
                  onClick={() => {
                    setFocus({ dimension: shown, key: row.key, row });
                    setDimension(usageDimensions({ dimension: shown, key: row.key })[0]!);
                  }}
                />
              );
            })}
          </div>
        </>
      ) : null}

      <p className="px-1 text-meta text-muted-foreground">
        <Trans>Model spend uses your provider keys.</Trans>
      </p>
    </div>
  );
}
