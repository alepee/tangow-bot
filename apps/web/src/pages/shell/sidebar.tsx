import { useLingui } from "@lingui/react/macro";
import type { RefObject } from "react";
import { BOTS_SIDEBAR_EDGE_DRAG_PX } from "../../lib/bots-sidebar-pref";
import { useMediaQuery } from "../../lib/use-media-query";
import { ActivityList } from "../ActivityList";
import type { SidebarArchivedProps, SidebarFooterProps } from "./sidebar-footer";
import { SidebarArchived, SidebarFooter } from "./sidebar-footer";
import type { SidebarHeaderProps } from "./sidebar-header";
import { SidebarHeader } from "./sidebar-header";
import type { SidebarRosterProps } from "./sidebar-roster";
import { SidebarRoster } from "./sidebar-roster";

type BotsSidebarProps = SidebarHeaderProps &
  SidebarRosterProps &
  SidebarArchivedProps &
  SidebarFooterProps & {
    botsSidebarCollapsed: boolean;
    mobileSidebarOpen: boolean;
    botsSidebarEdgeDragRef: RefObject<{ startX: number; mode: "expand" | "collapse" } | null>;
  };

export function BotsSidebar(props: BotsSidebarProps) {
  const {
    botsSidebarCollapsed,
    mobileSidebarOpen,
    activityMode,
    setBotsSidebarCollapsedPref,
    navigate,
    botsSidebarEdgeDragRef,
  } = props;
  const { t } = useLingui();
  // Below `md` the sidebar is the bot list's own page, on the page background.
  const desktopWidth = useMediaQuery("(min-width: 768px)");
  return (
    <>
      {/* The column: the sidebar floats 8 from the window's edges inside it, over the ambient
          light. At phone width it is the bot list's own page, full screen. */}
      <aside
        data-testid="bots-sidebar"
        data-collapsed={botsSidebarCollapsed ? "true" : "false"}
        inert={botsSidebarCollapsed && !mobileSidebarOpen ? true : undefined}
        className={`absolute inset-0 z-40 flex shrink-0 flex-col transition-[width,opacity,padding] md:relative md:inset-auto md:z-auto ${
          mobileSidebarOpen ? "" : "max-md:hidden"
        } ${
          botsSidebarCollapsed
            ? "md:w-0 md:overflow-hidden md:p-0 md:opacity-0 md:pointer-events-none"
            : "md:w-sidebar md:p-2"
        }`}
      >
        <div aria-hidden="true" className="app-drag absolute inset-x-0 top-0 h-2" />
        <div
          data-testid="bots-sidebar-pane"
          className={`flex min-h-0 flex-1 flex-col overflow-hidden md:rounded-pane ${
            desktopWidth
              ? "rk-glass-chrome"
              : // The list sits on the page background, which Safari paints its bars in.
                "bg-background"
          }`}
        >
          <SidebarHeader {...props} />
          <div className="rk-scroll flex flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-2.5">
            {activityMode ? (
              <ActivityList
                onOpenRun={(run) => {
                  if (run.groupId) navigate(`/app/g/${run.groupId}`);
                  else navigate(`/app/${run.botId}`);
                }}
              />
            ) : null}
            <SidebarRoster {...props} />
            <SidebarArchived {...props} />
          </div>
          <SidebarFooter {...props} />
        </div>
      </aside>

      <button
        type="button"
        data-testid="bots-sidebar-edge"
        aria-label={botsSidebarCollapsed ? t`Show bots` : t`Hide bots`}
        aria-pressed={!botsSidebarCollapsed}
        className={`absolute inset-y-0 z-50 hidden w-2 cursor-ew-resize touch-none border-0 bg-transparent p-0 md:block ${
          botsSidebarCollapsed ? "start-0" : "-ms-2 start-sidebar"
        }`}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          botsSidebarEdgeDragRef.current = {
            startX: event.clientX,
            mode: botsSidebarCollapsed ? "expand" : "collapse",
          };
        }}
        onPointerMove={(event) => {
          const drag = botsSidebarEdgeDragRef.current;
          if (!drag) return;
          const rtl =
            typeof document !== "undefined" &&
            document.documentElement.getAttribute("dir") === "rtl";
          const delta = rtl ? drag.startX - event.clientX : event.clientX - drag.startX;
          if (drag.mode === "expand" && delta >= BOTS_SIDEBAR_EDGE_DRAG_PX) {
            botsSidebarEdgeDragRef.current = null;
            setBotsSidebarCollapsedPref(false);
          } else if (drag.mode === "collapse" && delta <= -BOTS_SIDEBAR_EDGE_DRAG_PX) {
            botsSidebarEdgeDragRef.current = null;
            setBotsSidebarCollapsedPref(true);
          }
        }}
        onPointerUp={(event) => {
          const drag = botsSidebarEdgeDragRef.current;
          botsSidebarEdgeDragRef.current = null;
          if (!drag) return;
          if (Math.abs(event.clientX - drag.startX) < BOTS_SIDEBAR_EDGE_DRAG_PX) {
            setBotsSidebarCollapsedPref(!botsSidebarCollapsed);
          }
        }}
        onPointerCancel={() => {
          botsSidebarEdgeDragRef.current = null;
        }}
      />
    </>
  );
}
