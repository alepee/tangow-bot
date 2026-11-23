import type { Bot, BotMcpServer, IntegrationSetupState, McpServer } from "@tangow/contracts";
import { deriveMcpApp } from "@tangow/core";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Button,
  Linking,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { NativeMenu } from "../components/native-menu";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";

export default function CustomApps() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [assignments, setAssignments] = useState<BotMcpServer[]>([]);
  const [webUrl, setWebUrl] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState<{
    server: McpServer;
    created: boolean;
    message: string;
  } | null>(null);
  const [webRequired, setWebRequired] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const [rows, agents, links, setup] = await Promise.all([
      rpc<McpServer[]>("mcp/servers/list"),
      rpc<Bot[]>("bots/list"),
      rpc<BotMcpServer[]>("mcp/assignments/all"),
      rpc<IntegrationSetupState>("integrationSetup/get"),
    ]);
    setServers(rows);
    setBots(agents.filter((bot) => bot.isOwner && !bot.archivedAt));
    setAssignments(links);
    setWebUrl(new URL("/app?customize=custom-apps", setup.webUrl).href);
    setReady(true);
  }
  function report(reason: unknown) {
    setError(reason instanceof Error ? reason.message : t("Could not connect"));
  }
  useFocusEffect(
    useCallback(() => {
      void refresh().catch(report);
    }, []),
  );
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      report(reason);
    } finally {
      setBusy(false);
    }
  }
  async function connect(server: McpServer, created: boolean, withToken = false) {
    const result = await rpc<{
      status:
        | "authorization_required"
        | "authorization_not_requested"
        | "already_connected"
        | "token_required";
    }>("mcp/oauth/begin", {
      serverId: server.id,
      redirectUri: new URL("/mcp/oauth/callback", webUrl).href,
    });
    if (result.status === "token_required") {
      setEndpoint(server.endpoint ?? "");
      setPending({
        server,
        created,
        message: withToken
          ? t("This access token was refused.")
          : t("This app needs an access token."),
      });
    } else {
      setPending(null);
      setEndpoint("");
      setSecret("");
    }
    setWebRequired(result.status === "authorization_required");
    await refresh();
  }
  async function add() {
    if (pending) {
      await rpc("mcp/servers/update", { id: pending.server.id, secret });
      await connect(pending.server, pending.created, true);
      return;
    }
    const input = deriveMcpApp(endpoint);
    const existing = servers.find(
      (server) => server.endpoint && new URL(server.endpoint).href === input.endpoint,
    );
    const server =
      existing ??
      (await rpc<McpServer>("mcp/servers/create", { ...input, botIds: bots.map((bot) => bot.id) }));
    if (!existing) setServers((current) => [...current, server]);
    await connect(server, !existing);
  }
  async function toggle(serverId: string, botId: string) {
    const current = assignments.filter((entry) => entry.botId === botId);
    const next = current.some((entry) => entry.serverId === serverId)
      ? current.filter((entry) => entry.serverId !== serverId)
      : [...current, { serverId, allowAllTools: true, allowedTools: [] }];
    await rpc("mcp/assignments/replace", { botId, assignments: next });
    await refresh();
  }
  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <View style={styles.group}>
        <TextInput
          accessibilityLabel={t("App URL")}
          placeholder="https://example.com/mcp"
          placeholderTextColor={native.tertiaryLabel}
          value={endpoint}
          onChangeText={setEndpoint}
          editable={!busy && !pending}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={styles.input}
        />
        {pending ? (
          <>
            <Text style={styles.text}>{pending.message}</Text>
            <TextInput
              accessibilityLabel={t("Access token")}
              placeholder={t("Access token")}
              placeholderTextColor={native.tertiaryLabel}
              value={secret}
              onChangeText={setSecret}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              style={styles.input}
            />
          </>
        ) : null}
        <Button
          title={t("Add")}
          disabled={busy || !ready || (pending ? !secret.trim() : !endpoint.trim())}
          onPress={() => void run(add)}
        />
        {pending ? (
          <Button
            title={t("Cancel")}
            disabled={busy}
            onPress={() =>
              void run(async () => {
                if (pending.created) await rpc("mcp/servers/remove", { id: pending.server.id });
                setPending(null);
                setEndpoint("");
                setSecret("");
                await refresh();
              })
            }
          />
        ) : null}
      </View>
      {webRequired ? (
        <View style={styles.group}>
          <Text style={styles.text}>{t("Finish MCP authorization in the web app.")}</Text>
          <Button
            title={t("Open web app")}
            onPress={() =>
              void run(async () => {
                await Linking.openURL(webUrl);
              })
            }
          />
        </View>
      ) : null}
      {!ready || busy ? <ActivityIndicator /> : null}
      {ready && servers.length === 0 ? (
        <Text style={styles.secondary}>
          {t("Paste an app's MCP URL to give it to your agents.")}
        </Text>
      ) : null}
      {servers.map((server) => (
        <View key={server.id} style={styles.group}>
          <NativeMenu
            disabled={busy}
            title={server.name}
            accessibilityLabel={server.name}
            actions={[
              ...(server.oauthStatus !== "none"
                ? [
                    {
                      label: t("Disconnect"),
                      onPress: () =>
                        void run(async () => {
                          await rpc("mcp/oauth/disconnect", { serverId: server.id });
                          await refresh();
                        }),
                    },
                  ]
                : []),
              {
                label: t("Delete"),
                destructive: true,
                onPress: () =>
                  Alert.alert(t("Confirm delete"), server.name, [
                    { text: t("Cancel"), style: "cancel" },
                    {
                      text: t("Delete"),
                      style: "destructive",
                      onPress: () =>
                        void run(async () => {
                          await rpc("mcp/servers/remove", { id: server.id });
                          await refresh();
                        }),
                    },
                  ]),
              },
            ]}
          >
            <View style={styles.row}>
              <View style={styles.name}>
                <Text style={styles.text}>{server.name}</Text>
                <Text style={styles.secondary}>
                  {server.endpoint ? new URL(server.endpoint).host : server.command}
                </Text>
              </View>
              <Text style={styles.text}>⋯</Text>
            </View>
          </NativeMenu>
          {server.oauthStatus === "reconnect" ? (
            <View style={styles.row}>
              <Text style={styles.secondary}>{t("Reconnect needed")}</Text>
              <Button
                title={t("Reconnect")}
                disabled={busy}
                onPress={() => void run(() => connect(server, false))}
              />
            </View>
          ) : null}
          {bots.map((bot) => (
            <View key={bot.id} style={styles.row}>
              <Text style={styles.text}>{bot.name}</Text>
              <Switch
                accessibilityLabel={bot.name}
                disabled={busy}
                value={assignments.some(
                  (entry) => entry.botId === bot.id && entry.serverId === server.id,
                )}
                onValueChange={() => void run(() => toggle(server.id, bot.id))}
              />
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}
function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    content: { padding: 20, gap: 16 },
    group: { padding: 16, gap: 12, borderRadius: 12, backgroundColor: tokens.card },
    row: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    name: { flex: 1 },
    text: { color: native.label, fontSize: 16 },
    secondary: { color: native.secondaryLabel, fontSize: 14 },
    input: {
      minHeight: 44,
      padding: 12,
      borderRadius: 10,
      backgroundColor: native.fill,
      color: native.label,
    },
    error: { color: tokens.destructive },
  });
}
