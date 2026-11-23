import { useLingui } from "@lingui/react/macro";
import type { Bot, IntegrationSetupState } from "@tangow/contracts";
import { NativeSelect, NativeSelectOption } from "@tangow/ui-web";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { IntegrationSetup } from "../components/integrations/IntegrationSetup";
import { rpc } from "../lib/rpc";

export function IntegrationSetupPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const serverSetup = params.get("mode") !== "mcp";
  const { t } = useLingui();
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState("");
  const [ready, setReady] = useState(false);
  const [setupState, setSetupState] = useState<IntegrationSetupState | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!serverSetup) {
      navigate("/app?customize=custom-apps", { replace: true });
      return;
    }
    setReady(false);
    setError(false);
    let cancelled = false;
    void Promise.all([rpc.bots.list(), rpc.integrationSetup.get()])
      .then(([rows, setup]) => {
        if (cancelled) return;
        if (!setup?.canConfigure) {
          navigate("/app", { replace: true });
          return;
        }
        if (!rows.length) {
          navigate("/onboarding", { replace: true });
          return;
        }
        setSetupState(setup);
        setBots(rows);
        setBotId(rows[0]?.id ?? "");
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [serverSetup, navigate]);
  return (
    <div className="min-h-full bg-background px-6 py-12">
      <div className="mx-auto max-w-[560px]">
        {bots.length > 1 ? (
          <NativeSelect
            aria-label={t`Bot`}
            value={botId}
            onChange={(event) => setBotId(event.target.value)}
            className="mb-6 w-full"
          >
            {bots.map((bot) => (
              <NativeSelectOption key={bot.id} value={bot.id}>
                {bot.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : null}
        {ready ? (
          <IntegrationSetup
            initialState={setupState}
            botId={botId || undefined}
            onDone={() => navigate(bots.length ? "/app" : "/onboarding")}
          />
        ) : (
          <p>{error ? t`Could not load bots. Reload to try again.` : t`Loading…`}</p>
        )}
      </div>
    </div>
  );
}
