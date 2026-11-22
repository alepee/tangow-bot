import { Trans } from "@lingui/react/macro";
import { buttonVariants, cn, OnboardingFrame } from "@tangow/ui-web";
import { Link } from "react-router-dom";
import { welcomeScene } from "./onboarding-scenes";

export function WelcomePage() {
  return (
    <div className="contents" data-tangow-surface="welcome">
      <OnboardingFrame
        onSubmit={(event) => event.preventDefault()}
        title={
          <Trans>
            Mold a bot.
            <br />
            Give it a job.
          </Trans>
        }
        scene={welcomeScene}
        actions={
          <>
            <Link to="/sign-up" className={cn(buttonVariants({ size: "full" }), "no-underline")}>
              <Trans>Sign up</Trans>
            </Link>
            <Link to="/sign-in">
              <Trans>Sign in</Trans>
            </Link>
          </>
        }
      />
    </div>
  );
}
