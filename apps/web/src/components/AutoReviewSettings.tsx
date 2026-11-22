import { Trans, useLingui } from "@lingui/react/macro";
import type { ActionAutoReviewSettings, SpaceDecisionConfig } from "@tangow/contracts";
import { Label, Switch } from "@tangow/ui-web";
import { TriangleAlert } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";

export function AutoReviewSettings({ onOpenDecisionModel }: { onOpenDecisionModel?: () => void }) {
  const { t } = useLingui();
  const switchId = useId();
  const [autoReview, setAutoReview] = useState<ActionAutoReviewSettings | null>(null);
  // undefined while loading or unreadable: the decision-model hint stays hidden.
  const [decision, setDecision] = useState<SpaceDecisionConfig | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc.autoReview
      .get()
      .then((next) => {
        if (!cancelled) setAutoReview(next);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : t`Could not load Auto Review`);
      });
    rpc.decision
      .providerConfig()
      .then((next) => {
        if (!cancelled) setDecision(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [t]);

  async function toggle(enabled: boolean) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      setAutoReview(await rpc.autoReview.set({ enabled }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save Auto Review`);
    } finally {
      setSaving(false);
    }
  }

  const enabled = autoReview?.enabled ?? false;
  const checkerMissing = enabled && autoReview?.checkerAvailable === false;
  const decisionMissing = enabled && !checkerMissing && decision === null;

  return (
    <section
      data-testid="auto-review-settings"
      className="rounded-card bg-group shadow-group px-4 py-4"
    >
      <h3 className="text-[15px] font-medium text-foreground">
        <Trans>Action confirmations</Trans>
      </h3>
      <div className="mt-3 flex items-start gap-3">
        <Switch
          id={switchId}
          data-testid="auto-review-toggle"
          className="mt-0.5"
          checked={enabled}
          disabled={saving || !autoReview}
          onCheckedChange={(checked) => void toggle(checked)}
        />
        <div>
          <Label htmlFor={switchId} className="text-[14px] font-normal text-foreground/75">
            <Trans>Auto-review bot actions</Trans>
          </Label>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {checkerMissing ? (
              <Trans>Add a model in Settings to use this.</Trans>
            ) : (
              <Trans>You'll be asked to confirm actions flagged as dangerous.</Trans>
            )}
          </p>
          {decisionMissing ? (
            <p
              data-testid="auto-review-decision-hint"
              className="mt-2 flex items-center gap-1.5 text-[13px] text-muted-foreground"
            >
              <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0 text-warning" />
              <span>
                <Trans>Improve accuracy by setting up a decision model.</Trans>
              </span>
              {onOpenDecisionModel ? (
                <button
                  type="button"
                  onClick={onOpenDecisionModel}
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  <Trans>Set up</Trans>
                </button>
              ) : null}
            </p>
          ) : null}
        </div>
      </div>
      {error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null}
    </section>
  );
}
