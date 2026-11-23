import { AVATAR_CHARACTERS } from "@tangow/contracts";
import { BotAvatar } from "@tangow/ui-web";
import { createRoot } from "react-dom/client";
import "../../src/styles.css";

/*
 * Bot avatars without a server. Query parameters pick what they show:
 *   status=<run status> (every avatar; default none)   size=<px> (default 80)
 *   live=none (leave out the avatars kept live)
 * Each character appears twice: as any avatar (`data-face="still"`, a still image at rest) and
 * kept live like the bot page's (`data-face="live"`), so a capture compares them at one size.
 */
const params = new URLSearchParams(window.location.search);
const status = params.get("status") ?? undefined;
const size = Number(params.get("size") ?? 80);
const withLive = params.get("live") !== "none";

createRoot(document.getElementById("root")!).render(
  <div className="flex flex-col gap-3 bg-background p-4">
    {AVATAR_CHARACTERS.map(({ id }) => (
      <div key={id} data-character={id} className="flex gap-3">
        <div data-face="still">
          <BotAvatar character={id} size={size} status={status} />
        </div>
        {withLive ? (
          <div data-face="live">
            <BotAvatar character={id} size={size} status={status} live />
          </div>
        ) : null}
      </div>
    ))}
  </div>,
);
