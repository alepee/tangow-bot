import { botColors } from "@tangow/ui-tokens";
import {
  BotAvatar,
  Button,
  ComposerAttachment,
  ComposerShell,
  FramedBlock,
  HoverPill,
  Interstitial,
  MessageBubble,
  MessageMeta,
  MessageRow,
  ReasoningDisclosure,
  ShareBar,
  Shimmer,
  StackedAvatars,
  StopContour,
  Surface,
  UserAvatar,
  UserBubble,
  WorkingLine,
} from "@tangow/ui-web";
import {
  BookOpen,
  Copy,
  Mic,
  MoreHorizontal,
  Plus,
  Reply,
  Send,
  Square,
  Volume2,
} from "lucide-react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles.css";

const MAYA = { color: botColors[0], identity: "maya" };
const ATLAS = { color: botColors[1], identity: "atlas" };
const IVY = { color: botColors[2], identity: "ivy" };
const ORB = { color: botColors[3], identity: "orb" };
const BOTS = [MAYA, ATLAS, IVY, ORB];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section data-section={title} className="flex flex-col gap-3">
      <h2 className="text-label text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Kitchen() {
  return (
    <main className="mx-auto flex w-full max-w-thread flex-col gap-7 bg-background px-3.5 py-8">
      <Section title="capsules">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="capsule" size="capsule">
            Allow once
          </Button>
          <Button consequential variant="capsule" size="capsule">
            Always allow this tool
          </Button>
          <Button variant="capsuleSecondary" size="capsule">
            Deny
          </Button>
          <Button variant="tertiary" size="capsule">
            Skip
          </Button>
          <Button disabled variant="capsule" size="capsule">
            Sending
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="quickReply" size="quickReply">
            Tuesday afternoon
          </Button>
          <Button variant="quickReply" size="quickReply">
            Thursday morning
          </Button>
          <Button variant="capsule" size="quickReply">
            Thursday morning
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button aria-label="Attach file" variant="roundIcon" size="roundIcon">
            <Plus />
          </Button>
          <Button aria-label="Reply" variant="roundIcon" size="roundIconSm">
            <Reply />
          </Button>
          <Button variant="capsule" size="stack">
            Allow once
          </Button>
          <Button aria-label="End call" variant="capsule" size="call">
            <Square />
          </Button>
        </div>
      </Section>

      <Section title="stacked avatars">
        <div className="flex flex-wrap items-center gap-6">
          <StackedAvatars items={BOTS.slice(0, 2)} size={20} label="Maya and Atlas" />
          <StackedAvatars items={BOTS} size={17} />
          <StackedAvatars items={BOTS} size={16} max={2} />
          <StackedAvatars items={[{ ...MAYA, working: true }]} size={14} />
        </div>
      </Section>

      <Section title="messages">
        <MessageRow
          avatar={<BotAvatar size={26} />}
          author="Maya"
          trailing={
            <HoverPill>
              <Button aria-label="Reply" variant="roundIcon" size="roundIconSm">
                <Reply />
              </Button>
              <Button aria-label="Copy" variant="roundIcon" size="roundIconSm">
                <Copy />
              </Button>
              <Button aria-label="Speak this reply" variant="roundIcon" size="roundIconSm">
                <Volume2 />
              </Button>
              <Button aria-label="More" variant="roundIcon" size="roundIconSm">
                <MoreHorizontal />
              </Button>
            </HoverPill>
          }
        >
          <MessageBubble inGroup meta={{ label: "2 sources" }}>
            Tuesday afternoon is the only slot that works for everyone. I can hold it until the end
            of the day.
          </MessageBubble>
        </MessageRow>
        <UserBubble>Hold it, and tell the team.</UserBubble>
        <Interstitial
          avatars={<StackedAvatars items={BOTS.slice(0, 2)} size={17} />}
          onClick={() => undefined}
        >
          Maya asked Atlas for the room list · 40s
        </Interstitial>
        <WorkingLine
          avatar={<BotAvatar size={26} status="running" />}
          label="Maya is drafting the recap"
          startedAt={Date.now() - 41_300}
        />
        {/* A long live activity line, laid out like the transcript's working row. */}
        <div className="flex min-h-10 items-center px-1" data-testid="working-line-long">
          <WorkingLine
            avatar={<BotAvatar size={26} status="running" />}
            label="Searching the web: Club Med Marrakech OR Agadir OR Palmyre OR Djerba OR Opio OR Grand Massif baby club toussaint"
            startedAt={Date.now() - 12_000}
          />
        </div>
        <div className="text-reasoning text-muted-foreground">
          <Shimmer>Reading the calendar</Shimmer>
        </div>
        {/* A caller's utility has to beat the class the primitive brings. */}
        <div className="text-reasoning">
          <Shimmer className="text-destructive" data-testid="shimmer-override">
            A utility passed by the caller wins
          </Shimmer>
        </div>
        <div className="flex items-center gap-3 self-end">
          <UserAvatar initials="RJ" className="size-6 text-label" />
          <UserAvatar initials="RJ" className="size-14 text-title" />
        </div>
      </Section>

      <Section title="reasoning">
        <ReasoningDisclosure summary="Thought for 41s · 3 steps" open={false} onToggle={() => {}}>
          <span>Read the calendar</span>
        </ReasoningDisclosure>
        <ReasoningDisclosure summary="Thought for 41s · 3 steps" open live onToggle={() => {}}>
          <span>Read the calendar</span>
          <span>Compared four rooms</span>
          <span>Drafting the recap</span>
        </ReasoningDisclosure>
      </Section>

      <Section title="framed blocks">
        <FramedBlock
          header={{ who: "Maya needs your call", dot: true }}
          question="Send the recap to #ops?"
          consequence="They will see the last 12 messages of this thread."
          actions={
            <>
              <Button variant="tertiary" size="capsule">
                Deny
              </Button>
              <Button variant="capsuleSecondary" size="capsule">
                Always allow this tool
              </Button>
              <Button consequential variant="capsule" size="capsule">
                Allow once
              </Button>
            </>
          }
        />
        <FramedBlock
          question="Which room should I hold?"
          actionsAlign="start"
          actions={
            <Button variant="tertiary" size="capsule">
              Other answer…
            </Button>
          }
        >
          <Button variant="quickReply" size="quickReply">
            The roof terrace
          </Button>
        </FramedBlock>
        {/* Once answered the block drops its controls and its actions, even
            though both are still passed. */}
        <FramedBlock
          header={{ who: "Maya asked" }}
          question="Which room should I hold?"
          answered="Answered: the roof terrace"
          actions={
            <Button variant="capsule" size="capsule">
              Send
            </Button>
          }
        >
          <Button variant="quickReply" size="quickReply">
            The roof terrace
          </Button>
        </FramedBlock>
      </Section>

      <Section title="surfaces">
        <Surface as="section" className="p-4 text-meta text-muted-foreground">
          An unframed card: the bot's paper, never lifted.
        </Surface>
        <Surface variant="outlined" className="p-4 font-mono text-mono text-foreground">
          pnpm --filter @tangow/ui-tokens generate
        </Surface>
      </Section>

      <Section title="share bar">
        <ShareBar
          segments={[
            { key: "maya", value: 6, color: MAYA.color },
            { key: "atlas", value: 3, color: ATLAS.color },
          ]}
        />
        <ShareBar
          segments={[
            { key: "a", value: 5 },
            { key: "b", value: 3 },
            { key: "c", value: 2 },
            { key: "d", value: 1 },
            { key: "e", value: 1 },
          ]}
        />
      </Section>

      <Section title="composer">
        <ComposerShell
          attach={
            <Button aria-label="Attach file" variant="roundIcon" size="roundIcon">
              <Plus />
            </Button>
          }
        >
          <span className="text-body text-muted-foreground">Message Maya</span>
        </ComposerShell>
        <ComposerShell
          state="dictating"
          attach={
            <Button aria-label="Attach file" variant="roundIcon" size="roundIcon">
              <Plus />
            </Button>
          }
          trailing={
            <Button aria-label="Voice" variant="roundIcon" size="roundIcon">
              <Mic />
            </Button>
          }
        >
          <span className="text-body text-foreground">Hold the roof terrace</span>
        </ComposerShell>
        <ComposerShell
          attach={
            <Button aria-label="Attach file" variant="roundIcon" size="roundIcon">
              <Plus />
            </Button>
          }
          attachments={
            <ComposerAttachment name="roof-terrace.jpg" removeLabel="Remove roof-terrace.jpg" />
          }
          trailing={
            <Button aria-label="Stop" variant="roundIcon" size="roundIcon">
              <StopContour color={IVY.color} />
            </Button>
          }
        >
          <span className="text-body text-foreground-subtle">Message Ivy</span>
        </ComposerShell>
        <ComposerShell
          state="speaking"
          leading={<BotAvatar size={26} status="running" />}
          trailing={
            <Button variant="capsuleSecondary" size="capsule">
              Stop
            </Button>
          }
        >
          <span className="text-working text-muted-foreground">Ivy is speaking</span>
        </ComposerShell>
      </Section>
      <Section title="message proof lines">
        <MessageBubble
          inGroup
          data-testid="message-meta-lines"
          meta={[
            {
              label: "Sent to #ops",
              icon: <Send aria-hidden className="size-3.5 shrink-0" />,
              onClick: () => undefined,
            },
            {
              label: "Skill learned · Book a room for the whole team across every office",
              icon: <BookOpen aria-hidden className="size-3.5 shrink-0" />,
              onClick: () => undefined,
            },
          ]}
        >
          Booked Tuesday at 14:00.
        </MessageBubble>
        <div className="px-3.5" data-testid="message-meta-alone">
          <MessageMeta
            lines={{
              label: "Skill updated · Book a room",
              icon: <BookOpen aria-hidden className="size-3.5 shrink-0" />,
              onClick: () => undefined,
            }}
          />
        </div>
      </Section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Kitchen />);
