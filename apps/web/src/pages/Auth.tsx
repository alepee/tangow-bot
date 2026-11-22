import { Trans, useLingui } from "@lingui/react/macro";
import pave800 from "@tangow/avatars/onboarding/pave-800.webp";
import pave1600 from "@tangow/avatars/onboarding/pave-1600.webp";
import { readBoundedJsonResponse, signupRequiresEmailVerification } from "@tangow/core";
import {
  Button,
  buttonVariants,
  cn,
  FloatingField,
  Input,
  Label,
  OnboardingFrame,
} from "@tangow/ui-web";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { authClient } from "../lib/auth";
import { clearSpaceSelection } from "../lib/rpc";

type AuthMode = "in" | "up" | "forgot";
type PasswordResetCapabilities = { passwordReset: boolean; resetUrl: string | null };

const fieldClass =
  "mt-2 h-12 rounded-xl border-transparent bg-group px-4 text-base shadow-group md:text-base dark:bg-group";
const submitClass = "mt-3 h-12 w-full rounded-full text-base";
const AUTH_CAPABILITIES_TIMEOUT_MS = 8_000;
const MAX_AUTH_CAPABILITIES_RESPONSE_BYTES = 64 * 1024;

const paveScene = (
  <img
    src={pave800}
    srcSet={`${pave800} 800w, ${pave1600} 1600w`}
    sizes="(max-width: 860px) calc(100vw - 32px), 55vw"
    alt=""
  />
);

export function AuthPage({ mode }: { mode: AuthMode }) {
  const { t } = useLingui();
  const [searchParams, setSearchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentialsRejected, setCredentialsRejected] = useState(false);
  const [pending, setPending] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  // Signup triggers a session refresh that remounts the anonymous auth page.
  const verifying = searchParams.get("verify") === "email";
  // undefined while the capabilities request is in flight; null when it failed.
  const [reset, setReset] = useState<PasswordResetCapabilities | null>();

  useEffect(() => {
    if (mode === "up") return;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTH_CAPABILITIES_TIMEOUT_MS);
    void fetch("/api/auth/capabilities", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load authentication capabilities");
        return readBoundedJsonResponse<PasswordResetCapabilities>(
          response,
          MAX_AUTH_CAPABILITIES_RESPONSE_BYTES,
          controller.signal,
        );
      })
      .then((capabilities) => {
        if (active) setReset(capabilities);
      })
      .catch(() => {
        if (active) setReset(null);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [mode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setCredentialsRejected(false);
    try {
      if (mode === "forgot") {
        if (!reset?.passwordReset || !reset.resetUrl) {
          setError(t`Password recovery is not configured for this server`);
          return;
        }
        const result = await authClient.requestPasswordReset({
          email: email.trim(),
          redirectTo: reset.resetUrl,
        });
        if (result.error) {
          setError(result.error.message ?? t`Could not send reset email`);
          return;
        }
        setResetSent(true);
        return;
      }
      const result =
        mode === "up"
          ? await authClient.signUp.email({
              email,
              password,
              name: name || email.split("@")[0] || "User",
            })
          : await authClient.signIn.email({ email, password });
      if (result.error) {
        const rejected = result.error.code === "INVALID_EMAIL_OR_PASSWORD";
        setCredentialsRejected(rejected);
        setError(
          rejected ? t`Wrong email or password.` : (result.error.message ?? t`Could not continue`),
        );
        return;
      }
      if (mode === "up" && signupRequiresEmailVerification(result.data)) {
        setSearchParams({ verify: "email" });
        return;
      }
      clearSpaceSelection();
      // The session refetch that follows sign-in/sign-up lets the route redirect; navigating
      // first would reach a guarded route without a user and flash the sign-in page.
    } catch {
      setError(t`Couldn't reach the server.`);
    } finally {
      setPending(false);
    }
  }

  const passwordToggle = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => setShowPassword((shown) => !shown)}
      aria-label={showPassword ? t`Hide password` : t`Show password`}
      aria-pressed={showPassword}
      className="absolute inset-y-0 end-2 my-auto text-muted-foreground"
    >
      {showPassword ? <EyeOff /> : <Eye />}
    </Button>
  );

  if (mode === "in") {
    return (
      <OnboardingFrame
        onSubmit={submit}
        title={<Trans>Got the key?</Trans>}
        scene={paveScene}
        actions={
          <>
            <Button type="submit" size="full" disabled={pending} aria-busy={pending}>
              <Trans>Sign in</Trans>
            </Button>
            {reset?.passwordReset ? (
              <Link to="/forgot-password">
                <Trans>Forgot password?</Trans>
              </Link>
            ) : null}
            <p>
              <Trans>Don’t have an account?</Trans>{" "}
              <Link to="/sign-up">
                <Trans>Sign up</Trans>
              </Link>
            </p>
          </>
        }
      >
        <FloatingField
          id="email"
          name="email"
          label={<Trans>Email</Trans>}
          autoComplete="username"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <FloatingField
          id="current-password"
          name="password"
          label={<Trans>Password</Trans>}
          autoComplete="current-password"
          type={showPassword ? "text" : "password"}
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error}
          invalid={credentialsRejected}
        >
          {passwordToggle}
        </FloatingField>
      </OnboardingFrame>
    );
  }

  if (mode === "forgot") {
    return (
      <OnboardingFrame
        onSubmit={submit}
        title={resetSent ? <Trans>A new key is on its way.</Trans> : <Trans>Lost the key?</Trans>}
        scene={paveScene}
        actions={
          <>
            {resetSent ? null : (
              <Button
                type="submit"
                size="full"
                disabled={pending || reset === undefined}
                aria-busy={pending}
              >
                <Trans>Send reset link</Trans>
              </Button>
            )}
            <Link to="/sign-in">
              <Trans>Back to sign in</Trans>
            </Link>
          </>
        }
      >
        {resetSent ? (
          <p role="status">
            <Trans>If {email} has an account, the link is in its inbox.</Trans>
          </p>
        ) : (
          <FloatingField
            id="email"
            name="email"
            label={<Trans>Email</Trans>}
            autoComplete="username"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={error}
          />
        )}
      </OnboardingFrame>
    );
  }

  return (
    <AuthFrame
      onSubmit={submit}
      title={verifying ? <Trans>Check your email</Trans> : <Trans>Create your Tangow</Trans>}
    >
      {verifying ? (
        <div className="w-full text-center">
          <Link to="/sign-in" className="font-medium text-foreground">
            <Trans>Back to sign in</Trans>
          </Link>
        </div>
      ) : (
        <>
          <div className="mb-4 w-full">
            <Label htmlFor="name" className="text-muted-foreground">
              <Trans>Name</Trans>
            </Label>
            <Input
              id="name"
              name="name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t`Your name`}
              className={fieldClass}
            />
          </div>
          <div className="w-full">
            <Label htmlFor="email" className="text-muted-foreground">
              <Trans>Email</Trans>
            </Label>
            <Input
              id="email"
              name="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t`Your email address`}
              type="email"
              required
              className={fieldClass}
            />
          </div>
          <div className="mt-4 w-full">
            <Label htmlFor="new-password" className="text-muted-foreground">
              <Trans>Password</Trans>
            </Label>
            <div className="relative">
              <Input
                id="new-password"
                name="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t`Password`}
                type={showPassword ? "text" : "password"}
                required
                minLength={8}
                className={`${fieldClass} pr-12`}
              />
              {passwordToggle}
            </div>
          </div>
          {error ? (
            <p role="alert" className="mt-3 w-full text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" size="lg" disabled={pending} className={submitClass}>
            {pending ? <Trans>Working…</Trans> : <Trans>Create account</Trans>}
          </Button>
          <p className="mt-8 text-muted-foreground">
            <Trans>Already have an account?</Trans>{" "}
            <Link to="/sign-in" className="font-medium text-foreground">
              <Trans>Sign in</Trans>
            </Link>
          </p>
        </>
      )}
    </AuthFrame>
  );
}

type ResetStep = "form" | "expired" | "done";

export function PasswordResetPage() {
  const { t } = useLingui();
  const [params] = useSearchParams();
  const token = params.get("token");
  const [step, setStep] = useState<ResetStep>(params.get("error") ? "expired" : "form");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const [error, setError] = useState<string | null>(
    token ? null : t`This reset link is invalid or expired`,
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!token) return;
    const mismatched = password !== confirmation;
    setMismatch(mismatched);
    if (mismatched) {
      setError(t`Passwords do not match`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error?.code === "INVALID_TOKEN") setStep("expired");
      else if (result.error) setError(result.error.message ?? t`Could not reset password`);
      else setStep("done");
    } catch {
      setError(t`Couldn't reach the server.`);
    } finally {
      setPending(false);
    }
  }

  const actions =
    step === "done" ? (
      <Link to="/sign-in">
        <Trans>Sign in</Trans>
      </Link>
    ) : step === "expired" ? (
      <>
        <Link
          to="/forgot-password"
          className={cn(buttonVariants({ size: "full" }), "no-underline")}
        >
          <Trans>Send a new link</Trans>
        </Link>
        <Link to="/sign-in">
          <Trans>Back to sign in</Trans>
        </Link>
      </>
    ) : (
      <>
        <Button type="submit" size="full" disabled={pending || !token} aria-busy={pending}>
          <Trans>Reset password</Trans>
        </Button>
        <Link to="/sign-in">
          <Trans>Back to sign in</Trans>
        </Link>
      </>
    );

  return (
    <OnboardingFrame
      onSubmit={submit}
      title={<Trans>Reset your password</Trans>}
      scene={paveScene}
      actions={actions}
    >
      {step === "done" ? (
        <p role="status">
          <Trans>Password updated</Trans>
        </p>
      ) : step === "expired" ? (
        <p role="alert">
          <Trans>This link has expired or was already used.</Trans>
        </p>
      ) : (
        <>
          <FloatingField
            id="new-password"
            name="new-password"
            label={<Trans>New password</Trans>}
            autoComplete="new-password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <FloatingField
            id="confirm-password"
            name="confirm-password"
            label={<Trans>Confirm password</Trans>}
            autoComplete="new-password"
            type="password"
            required
            minLength={8}
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            error={error}
            invalid={mismatch}
          />
        </>
      )}
    </OnboardingFrame>
  );
}

function AuthFrame({
  title,
  onSubmit,
  children,
}: {
  title: React.ReactNode;
  onSubmit: (event: React.FormEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rk-ambient flex min-h-full items-center justify-center px-6 py-16 text-foreground">
      <form onSubmit={onSubmit} className="flex w-[460px] flex-col items-center">
        <div className="flex h-[74px] w-[74px] items-center justify-center gap-[11px] rounded-full bg-group shadow-group">
          <span className="h-5 w-[9px] rounded-full bg-primary" />
          <span className="h-5 w-[9px] rounded-full bg-primary" />
        </div>
        <h1 aria-live="polite" className="mb-9 mt-7 text-4xl font-medium tracking-tight">
          {title}
        </h1>
        {children}
      </form>
    </div>
  );
}
