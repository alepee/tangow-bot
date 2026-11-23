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
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BotAvatar } from "../components/bot-avatar";
import { SegmentedPicker } from "../components/segmented-picker";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";

const DIMENSIONS = new Set<string>(["bots", "models", "categories"]);

/** Spend by bot, model and category; a row opens the same screen focused on it. */
export default function Usage() {
  const styles = useThemedStyles(createUsageStyles);
  const tokens = mobileTokens();
  const { t, locale } = useI18n();
  const router = useRouter();
  const params = useLocalSearchParams<{
    period?: string;
    focusDimension?: string;
    focusKey?: string;
    title?: string;
  }>();
  const focus: UsageFocus | null =
    params.focusDimension && DIMENSIONS.has(params.focusDimension) && params.focusKey !== undefined
      ? { dimension: params.focusDimension as UsageDimension, key: params.focusKey }
      : null;
  const [period, setPeriod] = useState<UsagePeriod>(
    params.period === "7d" || params.period === "all" ? params.period : "30d",
  );
  const dimensions = usageDimensions(focus);
  const [dimension, setDimension] = useState<UsageDimension>(dimensions[0]!);
  const [cells, setCells] = useState<UsageCell[] | null>(null);

  useEffect(() => {
    let current = true;
    // A failed fetch must not leave another period's figures under this one.
    setCells(null);
    void rpc<UsageCell[]>("usage/breakdown", { period })
      .then((next) => {
        if (current) setCells(next);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [period]);

  const tokensOf = (value: number) => formatTokenCount(value, locale);
  const runs = (value: number) => (value === 1 ? t("1 run") : t("{count} runs", { count: value }));
  const compactions = (value: number) =>
    value === 1 ? t("1 compaction") : t("{count} compactions", { count: value });
  const average = (value: UsageAverage) =>
    value.per === "run"
      ? t("{count} · {input} in · {output} out / run", {
          count: runs(value.count),
          input: tokensOf(value.inputTokens),
          output: tokensOf(value.outputTokens),
        })
      : t("{count} · {input} in · {output} out / compaction", {
          count: compactions(value.count),
          input: tokensOf(value.inputTokens),
          output: tokensOf(value.outputTokens),
        });
  const categoryLabel = (category: UsageCategoryKey) =>
    ({
      fast: t("Fast"),
      everyday: t("Everyday"),
      complex: t("Complex"),
      fixed: t("Fixed"),
      compaction: t("Compaction"),
      unrecorded: t("Not recorded"),
    })[category];
  const rowLabel = (row: UsageRow) =>
    dimension === "bots"
      ? (row.bot?.name ?? t("Deleted bot"))
      : dimension === "models"
        ? row.model
        : categoryLabel(row.category);
  const tabLabels: Record<UsageDimension, string> = {
    bots: t("Bots"),
    models: t("Models"),
    categories: t("Categories"),
  };
  const { totals, rows } = pivotUsage(cells ?? [], dimension, focus);
  const ink = [tokens.foreground, tokens.mutedForeground, tokens.foregroundSubtle, tokens.input];

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <Stack.Screen options={{ title: params.title || t("Usage") }} />
      <ScrollView contentContainerStyle={styles.content}>
        <SegmentedPicker<UsagePeriod>
          label={t("Period")}
          selection={period}
          onChange={setPeriod}
          options={[
            { value: "7d", label: t("7d") },
            { value: "30d", label: t("30d") },
            { value: "all", label: t("All") },
          ]}
        />
        {cells && rows.length === 0 ? (
          <Text style={styles.empty}>{t("No usage in this period.")}</Text>
        ) : null}
        {rows.length > 0 ? (
          <>
            <View style={styles.group}>
              <View style={styles.figures}>
                <Text style={styles.figure}>
                  {tokensOf(totals.inputTokens)} <Text style={styles.unit}>{t("in")}</Text>
                </Text>
                <Text style={styles.figure}>
                  {tokensOf(totals.outputTokens)} <Text style={styles.unit}>{t("out")}</Text>
                </Text>
              </View>
              {totals.runs.count > 0 ? (
                <Text style={styles.subline}>{average(usageAverage(totals)!)}</Text>
              ) : null}
              {totals.compactions.count > 0 ? (
                <Text style={styles.subline}>
                  {t("{count} · {input} in · {output} out", {
                    count: compactions(totals.compactions.count),
                    input: tokensOf(totals.compactions.inputTokens),
                    output: tokensOf(totals.compactions.outputTokens),
                  })}
                </Text>
              ) : null}
            </View>
            <SegmentedPicker<UsageDimension>
              label={t("Breakdown")}
              selection={dimension}
              onChange={setDimension}
              options={dimensions.map((value) => ({ value, label: tabLabels[value] }))}
            />
            <View style={[styles.group, styles.list]}>
              {rows.map((row, index) => {
                const rowAverage = usageAverage(row);
                return (
                  <Pressable
                    key={row.key}
                    accessibilityRole="button"
                    onPress={() =>
                      router.push({
                        pathname: "/usage",
                        params: {
                          period,
                          focusDimension: dimension,
                          focusKey: row.key,
                          title: rowLabel(row),
                        },
                      })
                    }
                    style={({ pressed }) => [
                      styles.row,
                      index > 0 && styles.rowDivider,
                      pressed && styles.pressed,
                    ]}
                  >
                    {dimension === "bots" && row.bot && !row.bot.deleted ? (
                      <BotAvatar character={row.bot.avatarCharacter} size={28} />
                    ) : dimension === "bots" ? (
                      <View style={styles.goneAvatar} />
                    ) : (
                      <View
                        style={[
                          styles.dot,
                          { backgroundColor: ink[Math.min(index, ink.length - 1)] },
                        ]}
                      />
                    )}
                    <View style={styles.rowText}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {rowLabel(row)}
                        {dimension === "bots" && row.bot?.deleted ? (
                          <Text style={styles.subline}> {t("Deleted")}</Text>
                        ) : null}
                      </Text>
                      {rowAverage ? (
                        <Text style={styles.subline}>{average(rowAverage)}</Text>
                      ) : null}
                    </View>
                    <View style={styles.value}>
                      <Text style={styles.valueIn}>
                        {t("{value} in", { value: tokensOf(row.inputTokens) })}
                      </Text>
                      <Text style={styles.subline}>
                        {t("{value} out", { value: tokensOf(row.outputTokens) })}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </>
        ) : null}
        <Text style={styles.footnote}>{t("Model spend uses your provider keys.")}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function createUsageStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 14 },
    group: { borderRadius: 16, backgroundColor: native.fill, padding: 16, gap: 4 },
    list: { padding: 0, gap: 0, overflow: "hidden" },
    figures: { flexDirection: "row", gap: 20, alignItems: "baseline" },
    figure: { color: native.label, fontSize: 22, fontWeight: "700", fontVariant: ["tabular-nums"] },
    unit: { color: native.secondaryLabel, fontSize: 15, fontWeight: "400" },
    subline: { color: native.secondaryLabel, fontSize: 13, fontVariant: ["tabular-nums"] },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      minHeight: 56,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tokens.border },
    pressed: { backgroundColor: native.fillPressed },
    rowText: { flex: 1, gap: 2 },
    rowName: { color: native.label, fontSize: 16 },
    value: { alignItems: "flex-end" },
    valueIn: { color: native.label, fontSize: 15, fontVariant: ["tabular-nums"] },
    dot: { width: 10, height: 10, borderRadius: 5, marginHorizontal: 9 },
    goneAvatar: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: tokens.foregroundSubtle,
    },
    empty: { color: native.secondaryLabel, fontSize: 15, paddingVertical: 8 },
    footnote: { color: native.secondaryLabel, fontSize: 13 },
  });
}
