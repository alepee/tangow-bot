import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeMenu } from "../components/native-menu";
import { ServerSheet } from "../components/server-sheet";
import { SettingSwitch } from "../components/setting-switch";
import { UserAvatar } from "../components/user-avatar";
import type { MobileMe } from "../lib/api";
import {
  currentApiBase,
  deleteAccount,
  displayApiHost,
  fetchProfileImage,
  rpc,
  signOut,
  updateProfileImage,
} from "../lib/api";
import {
  getCachedAppearancePreference,
  mobileTokens,
  setAppearancePreference,
} from "../lib/appearance";
import { explicitSignInRoute } from "../lib/auth-routing";
import { setDebugMode, useDebugMode } from "../lib/debug-mode";
import { setUiLocale, useI18n } from "../lib/i18n";
import { userInitials } from "../lib/inbox";
import { native, useThemedStyles } from "../lib/native";
import {
  PROFILE_PHOTO_SIZE,
  profilePhotoDataUrl,
  setProfilePhoto,
  useProfilePhoto,
} from "../lib/profile-photo";
import type { AccountUiLocale } from "../lib/ui-locale";
import { ACCOUNT_UI_LOCALES, UI_LOCALE_LABELS } from "../lib/ui-locale";

/** The person's account, the same in every space. */
export default function Profile() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [me, setMe] = useState<MobileMe | null>(null);
  const [password, setPassword] = useState("");
  const [localeSaving, setLocaleSaving] = useState(false);
  const [localeError, setLocaleError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiBase, setApiBase] = useState(() => currentApiBase());
  const [serverOpen, setServerOpen] = useState(false);
  const appearance = getCachedAppearancePreference();
  const debug = useDebugMode();
  const styles = useThemedStyles(createProfileStyles);

  useEffect(() => {
    void rpc<MobileMe>("me")
      .then(setMe)
      .catch(() => undefined);
  }, []);

  async function handleSignOut() {
    setPending(true);
    setError(null);
    try {
      await signOut();
      router.dismissAll();
      router.replace(explicitSignInRoute);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not sign out"));
      setPending(false);
    }
  }

  function confirmDeletion() {
    setError(null);
    Alert.alert(
      t("Delete your account?"),
      t(
        "This permanently deletes your account, bots, conversations, memories, files, and saved connections. This cannot be undone.",
      ),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Delete account"),
          style: "destructive",
          onPress: () => void handleDeletion(),
        },
      ],
    );
  }

  function applyLocale(code: AccountUiLocale) {
    if (code === locale || localeSaving) return;
    setLocaleSaving(true);
    setLocaleError(null);
    void setUiLocale(code)
      .catch(() => {
        setLocaleError(t("Could not change language"));
      })
      .finally(() => setLocaleSaving(false));
  }

  async function handleDeletion() {
    setPending(true);
    setError(null);
    try {
      await deleteAccount(password);
      router.dismissAll();
      router.replace("/sign-in");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not delete account"));
    } finally {
      setPending(false);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.profile}>
          <Text style={styles.name}>{me?.name || t("Your account")}</Text>
          {me?.email ? <Text style={styles.email}>{me.email}</Text> : null}
          <ProfilePhoto initials={userInitials(me?.name ?? "")} />
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={() => router.push("/change-password")}
          style={({ pressed }) => [styles.settingsButton, pressed && styles.pressed]}
        >
          <Text style={styles.settingsTitle}>{t("Change password")}</Text>
          <Text style={styles.chevron}>›</Text>
        </Pressable>

        <View accessibilityLabel={t("Appearance")} style={styles.avatarSection}>
          <Text style={styles.settingsTitle}>{t("Appearance")}</Text>
          <View style={styles.appearanceOptions}>
            {(
              [
                ["system", "System"],
                ["light", "Light"],
                ["dark", "Dark"],
              ] as const
            ).map(([value, label]) => {
              const selected = appearance === value;
              const translated = t(label);
              return (
                <Pressable
                  key={value}
                  accessibilityLabel={translated}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => void setAppearancePreference(value)}
                  style={({ pressed }) => [
                    styles.appearanceOption,
                    selected && styles.appearanceOptionSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.appearanceLabel}>{translated}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View accessibilityLabel={t("Debug mode")} style={styles.profile}>
          <SettingSwitch
            label={t("Debug mode")}
            detail={t("Show agent steps, and every run in a bot's activity.")}
            value={debug}
            disabled={false}
            onChange={(next) => void setDebugMode(next)}
          />
        </View>

        <NativeMenu
          title={t("Language")}
          accessibilityLabel={t("Language")}
          accessibilityValue={UI_LOCALE_LABELS[locale]}
          disabled={localeSaving}
          options={ACCOUNT_UI_LOCALES.map((code) => ({
            value: code,
            label: UI_LOCALE_LABELS[code],
          }))}
          selected={locale}
          onSelect={(value) => {
            const code = ACCOUNT_UI_LOCALES.find((locale) => locale === value);
            if (code) applyLocale(code);
          }}
          style={({ pressed }) => [
            styles.settingsButton,
            pressed && styles.pressed,
            localeSaving && { opacity: 0.6 },
          ]}
        >
          <Text style={styles.settingsTitle}>{t("Language")}</Text>
          <View style={styles.settingsTrailing}>
            <Text style={styles.settingsValue}>{UI_LOCALE_LABELS[locale]}</Text>
            <Text style={styles.chevron}>›</Text>
          </View>
        </NativeMenu>
        {localeError ? <Text style={styles.error}>{localeError}</Text> : null}

        {me?.isDeploymentOwner ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push("/integration-setup")}
            style={styles.settingsButton}
          >
            <Text style={styles.settingsTitle}>{t("Server integrations")}</Text>
          </Pressable>
        ) : null}

        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => setServerOpen(true)}
          style={({ pressed }) => [styles.settingsButton, pressed && styles.pressed]}
        >
          <Text style={styles.settingsTitle}>{t("Server")}</Text>
          <View style={styles.settingsTrailing}>
            <Text numberOfLines={1} style={styles.settingsValue}>
              {displayApiHost(apiBase)}
            </Text>
            <Text style={styles.chevron}>›</Text>
          </View>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => void handleSignOut()}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        >
          <Text style={styles.buttonLabel}>{t("Sign out")}</Text>
        </Pressable>

        <View style={styles.dangerZone}>
          <Text style={styles.dangerTitle}>{t("Delete account")}</Text>
          <TextInput
            accessibilityLabel={t("Current password")}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending}
            onChangeText={(value) => {
              setPassword(value);
              setError(null);
            }}
            placeholder={t("Current password")}
            placeholderTextColor={native.tertiaryLabel}
            secureTextEntry
            style={styles.password}
            textContentType="password"
            value={password}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable
            accessibilityRole="button"
            disabled={pending || !password}
            onPress={confirmDeletion}
            style={({ pressed }) => [
              styles.deleteButton,
              (pending || !password) && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            {pending ? (
              <ActivityIndicator color={mobileTokens().destructiveForeground} />
            ) : (
              <Text style={styles.deleteLabel}>{t("Delete account")}</Text>
            )}
          </Pressable>
        </View>
      </ScrollView>
      <ServerSheet
        visible={serverOpen}
        current={apiBase}
        onClose={() => setServerOpen(false)}
        onSaved={(url) => {
          setServerOpen(false);
          if (url === apiBase) return;
          // A new origin drops the session with the old one.
          setApiBase(url);
          router.dismissAll();
          router.replace(explicitSignInRoute);
        }}
      />
    </SafeAreaView>
  );
}

/** Square WebP data URL small enough to live on the session user, or null when cancelled. */
async function encodeProfilePhoto(): Promise<string | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    // The square editor is the crop: React Native has no canvas to centre-crop on.
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
  });
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return null;
  const context = ImageManipulator.manipulate(asset.uri);
  context.resize({ width: PROFILE_PHOTO_SIZE, height: PROFILE_PHOTO_SIZE });
  const image = await context.renderAsync();
  const saved = await image.saveAsync({
    format: SaveFormat.WEBP,
    compress: 0.8,
    base64: true,
  });
  context.release();
  image.release();
  return saved.base64 ?? null;
}

function ProfilePhoto({ initials }: { initials: string }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createProfileStyles);
  const photo = useProfilePhoto();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchProfileImage()
      .then(setProfilePhoto)
      .catch(() => undefined);
  }, []);

  async function save(image: string | null) {
    setPending(true);
    setError(null);
    try {
      await updateProfileImage(image);
      setProfilePhoto(image);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not update your photo"));
    } finally {
      setPending(false);
    }
  }

  async function pick() {
    setError(null);
    let base64: string | null;
    try {
      base64 = await encodeProfilePhoto();
    } catch {
      setError(t("That image could not be read"));
      return;
    }
    if (base64 === null) return;
    const encoded = profilePhotoDataUrl(base64);
    if (!encoded.ok) {
      setError(
        encoded.reason === "too-large"
          ? t("That image is too detailed to store, try a simpler one")
          : t("That image could not be read"),
      );
      return;
    }
    await save(encoded.dataUrl);
  }

  return (
    <View accessibilityLabel={t("Profile photo")} style={styles.photoSection}>
      <Text style={styles.sectionTitle}>{t("Profile photo")}</Text>
      <View style={styles.photoRow}>
        <UserAvatar initials={initials} image={photo} size={56} fontSize={18} />
        {pending ? <ActivityIndicator color={native.secondaryLabel} /> : null}
        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => void pick()}
          style={({ pressed }) => [
            styles.photoAction,
            pending && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.restoreLabel}>{photo ? t("Change photo") : t("Add photo")}</Text>
        </Pressable>
        {photo ? (
          <Pressable
            accessibilityRole="button"
            disabled={pending}
            onPress={() => void save(null)}
            style={({ pressed }) => [
              styles.photoAction,
              pending && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.removeLabel}>{t("Remove")}</Text>
          </Pressable>
        ) : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function createProfileStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: native.page,
    },
    content: {
      flexGrow: 1,
      padding: 20,
      gap: 20,
    },
    profile: {
      borderRadius: 16,
      backgroundColor: native.fill,
      padding: 18,
      gap: 4,
    },
    name: {
      color: native.label,
      fontSize: 20,
      fontWeight: "600",
    },
    email: {
      color: native.secondaryLabel,
      fontSize: 15,
    },
    button: {
      minHeight: 50,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: native.fill,
    },
    buttonLabel: {
      color: native.label,
      fontSize: 17,
      fontWeight: "600",
    },
    sectionTitle: {
      color: native.secondaryLabel,
      fontSize: 14,
      fontWeight: "600",
    },
    restoreLabel: {
      color: native.label,
      fontSize: 14,
      fontWeight: "600",
    },
    removeLabel: {
      color: tokens.destructive,
      fontSize: 14,
    },
    photoSection: {
      marginTop: 14,
      gap: 12,
    },
    photoRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    photoAction: {
      minHeight: 40,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: native.tertiaryLabel,
      paddingHorizontal: 14,
      justifyContent: "center",
    },
    settingsButton: {
      minHeight: 62,
      borderRadius: 14,
      backgroundColor: native.fill,
      paddingHorizontal: 16,
      paddingVertical: 12,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    avatarSection: {
      borderRadius: 16,
      backgroundColor: native.fill,
      padding: 18,
      gap: 14,
    },
    appearanceOptions: {
      flexDirection: "row",
      gap: 8,
    },
    appearanceOption: {
      flex: 1,
      minHeight: 44,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: native.tertiaryLabel,
      alignItems: "center",
      justifyContent: "center",
    },
    appearanceOptionSelected: {
      borderColor: native.label,
      backgroundColor: native.fillPressed,
    },
    appearanceLabel: {
      color: native.label,
      fontSize: 14,
      fontWeight: "600",
    },
    settingsTitle: {
      color: native.label,
      fontSize: 17,
      fontWeight: "600",
    },
    settingsTrailing: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minWidth: 0,
    },
    settingsValue: {
      color: native.secondaryLabel,
      fontSize: 15,
    },
    chevron: {
      color: native.secondaryLabel,
      fontSize: 28,
      fontWeight: "300",
    },
    dangerZone: {
      marginTop: 12,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: tokens.destructive,
      padding: 18,
    },
    dangerTitle: {
      color: tokens.destructive,
      fontSize: 17,
      fontWeight: "600",
    },
    password: {
      height: 48,
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      paddingHorizontal: 14,
      marginTop: 16,
      fontSize: 16,
    },
    error: {
      color: tokens.destructive,
      fontSize: 14,
      marginTop: 10,
    },
    deleteButton: {
      minHeight: 50,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: tokens.destructive,
      marginTop: 14,
    },
    deleteLabel: {
      color: tokens.destructiveForeground,
      fontSize: 16,
      fontWeight: "700",
    },
    disabled: {
      opacity: 0.45,
    },
    pressed: {
      opacity: 0.7,
    },
  });
}
