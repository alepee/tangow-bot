import { BOT_NAME_MAX_LENGTH, BOT_TITLE_MAX_LENGTH } from "@tangow/contracts";
import { radii, shadowsForAppearance } from "@tangow/ui-tokens";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, type TextStyle, View } from "react-native";
import { mobileTokens, resolveMobileAppearance } from "../../lib/appearance";
import { type BotPageContext, type FieldSave, shownSave, useBotSetting } from "../../lib/bot-page";
import { BOT_TABS, type BotTab } from "../../lib/bot-tab";
import { useI18n } from "../../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../../lib/native";
import { leaveTextField, restingText } from "../../lib/text-field";
import { nativeTextStyle } from "../../lib/typography";
import { BotAvatar } from "../bot-avatar";
import { SaveMeta } from "./kit";

/** The avatar, name and title at the top of the page, each saving on its own. */
export function BotHero({
  page,
  onAppearance,
}: {
  page: BotPageContext;
  onAppearance: () => void;
}) {
  const styles = useThemedStyles(createHeroStyles);
  const { t } = useI18n();
  const { bot, readOnly } = page;
  const name = useBotSetting(page, "name");
  const title = useBotSetting(page, "title");
  const character = useBotSetting(page, "avatarCharacter");
  const meta = shownSave([name, title, character]);

  return (
    <View style={styles.hero}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Appearance")}
        disabled={readOnly}
        onPress={onAppearance}
        hitSlop={8}
      >
        <BotAvatar character={character.value} size={88} status={bot.status} live />
      </Pressable>
      <HeroText
        field={name}
        required
        maxLength={BOT_NAME_MAX_LENGTH}
        label={t("Name")}
        disabled={readOnly}
        style={styles.name}
      />
      <HeroText
        field={title}
        maxLength={BOT_TITLE_MAX_LENGTH}
        label={t("Title")}
        placeholder={t("What it does, in one line")}
        disabled={readOnly}
        style={styles.title}
      />
      <View style={styles.meta}>
        {meta ? <SaveMeta state={meta.state} onRetry={() => void meta.retry()} /> : null}
      </View>
    </View>
  );
}

/** Text edited in place: saved when it loses focus, only when the trimmed text changed. */
function HeroText({
  field,
  required,
  maxLength,
  label,
  placeholder,
  disabled,
  style,
}: {
  field: FieldSave<string>;
  required?: boolean;
  maxLength: number;
  label: string;
  placeholder?: string;
  disabled: boolean;
  style: TextStyle;
}) {
  const tokens = useMobileTokens();
  const resting = restingText(field);
  const [text, setText] = useState(resting);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(resting);
  }, [editing, resting]);

  const commit = () => {
    setEditing(false);
    leaveTextField(field, text, { required });
  };

  return (
    <TextInput
      accessibilityLabel={label}
      value={text}
      onChangeText={setText}
      onFocus={() => setEditing(true)}
      onBlur={commit}
      editable={!disabled}
      maxLength={maxLength}
      placeholder={placeholder}
      placeholderTextColor={tokens.mutedForeground}
      returnKeyType="done"
      submitBehavior="blurAndSubmit"
      textAlign="center"
      style={style}
    />
  );
}

/**
 * The page's destinations in one round pill; the selected one sits on the surface.
 * `routineFailed` puts a dot on Activity while a routine's last run failed.
 */
export function BotTabs({
  value,
  onChange,
  routineFailed = false,
}: {
  value: BotTab;
  onChange: (tab: BotTab) => void;
  routineFailed?: boolean;
}) {
  const styles = useThemedStyles(createHeroStyles);
  const { t } = useI18n();
  const labels: Record<BotTab, string> = {
    activity: t("Activity"),
    routines: t("Routines"),
    knowledge: t("Knowledge"),
    settings: t("Settings"),
  };
  return (
    <View style={styles.tabs} accessibilityRole="tablist">
      {BOT_TABS.map((tab) => {
        const selected = tab === value;
        const dot = tab === "activity" && routineFailed;
        return (
          <Pressable
            key={tab}
            accessibilityRole="tab"
            accessibilityLabel={dot ? t("Activity, last run failed") : undefined}
            accessibilityState={{ selected }}
            onPress={() => onChange(tab)}
            style={[styles.tab, selected && styles.tabOn]}
          >
            <Text
              style={[styles.tabLabel, selected && styles.tabLabelOn]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.85}
            >
              {labels[tab]}
            </Text>
            {dot ? <View style={styles.tabDot} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function createHeroStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    hero: { alignItems: "center", paddingTop: 12, paddingHorizontal: 20 },
    name: {
      alignSelf: "stretch",
      marginTop: 16,
      paddingVertical: 2,
      color: tokens.foreground,
      ...nativeTextStyle("title", { size: 22, weight: 600 }),
    },
    title: {
      alignSelf: "stretch",
      marginTop: 2,
      paddingVertical: 2,
      color: tokens.mutedForeground,
      ...nativeTextStyle("meta", { size: 15 }),
    },
    meta: { minHeight: 18, marginTop: 6, alignItems: "center" },
    tabs: {
      flexDirection: "row",
      padding: 3,
      gap: 2,
      borderRadius: radii.pill,
      backgroundColor: tokens.muted,
    },
    tab: {
      flex: 1,
      minHeight: 34,
      paddingHorizontal: 6,
      borderRadius: radii.pill,
      flexDirection: "row",
      gap: 4,
      alignItems: "center",
      justifyContent: "center",
    },
    tabDot: { width: 6, height: 6, borderRadius: radii.pill, backgroundColor: tokens.destructive },
    tabOn: {
      backgroundColor: tokens.surface,
      boxShadow: shadowsForAppearance(resolveMobileAppearance()).row,
    },
    tabLabel: { color: tokens.mutedForeground, ...nativeTextStyle("meta", { size: 14 }) },
    tabLabelOn: { color: tokens.foreground, fontWeight: "600" },
  });
}
