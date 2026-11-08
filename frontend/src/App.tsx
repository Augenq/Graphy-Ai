import { UIProvider } from "./components/ui/controls";
import { IconButton } from "./components/ui/index";
import { t } from "./lib/i18n";
import { isImeKey } from "./lib/ime";
import { viewportWidth } from "./lib/layout";
import { SidebarSimple, NotePencil } from "@phosphor-icons/react";

import { MotionConfig } from "motion/react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Composer } from "./components/Composer";
import { ToastHost } from "./components/ToastHost";
import { ConnectionGate, OfflineBanner } from "./components/ConnectionGate";
import { Thread } from "./components/Chat";
import { useTrackViewing } from "./lib/lesson-state";
import { refreshRole } from "./lib/teaching-api";
import { Home } from "./components/Home";
import { LazyBoundary, clearReloadFlag } from "./components/LazyBoundary";
import { Panel } from "./components/Panel";
import { SessionBar } from "./components/SessionBar";
import { useSettings } from "./lib/settings";
import { isPhone, useSettingsRoute } from "./lib/settings-route";
import { Sidebar } from "./components/Sidebar";
import { Tip } from "./components/Tip";
import { iconBtn } from "./components/ui";
import { useBackend } from "./lib/backend";
import { startMaxLoops, useMax } from "./lib/max";
import { MaxGate } from "./components/MaxGate";
import { setTeacherMode } from "./lib/teaching-api";
import { openSession as openLesson, stop } from "./lib/engine";
import { useRemote } from "./lib/remote";
import { getState, setActive, useSession, useStore } from "./lib/store";
import { startSync, stopSync } from "./lib/sync";
import { isBusy } from "./lib/types";

// Screens that are not the first paint load on demand; they are fetched in the idle time after start-up, so opening one shows no gap.
// The fallback is empty on purpose: each of them is a surface of its own (page, dialog) that appears in one piece.
const loadStudy = () => import("./components/StudyView").then((m) => ({ default: m.StudyView }));
const loadSchool = () => import("./components/school/SchoolTab").then((m) => ({ default: m.SchoolTab }));
const loadSearch = () => import("./components/SearchPalette").then((m) => ({ default: m.SearchPalette }));
const loadSettings = () => import("./components/SettingsPage").then((m) => ({ default: m.SettingsPage }));
const loadFirstRun = () => import("./components/FirstRun").then((m) => ({ default: m.FirstRun }));
const StudyView = lazy(loadStudy);
const SchoolTab = lazy(loadSchool);
const SearchPalette = lazy(loadSearch);
const SettingsPage = lazy(loadSettings);
const FirstRun = lazy(loadFirstRun);
function preloadScreens() {
  for (const load of [loadSettings, loadSearch, loadStudy, loadSchool, loadFirstRun]) void load().catch(() => undefined);
}

type View = "home" | "lesson" | "study" | "school";

/** Desktop panels share the layout; compact windows use an overlay. */
const DOCK_SIDEBAR = 1100;
const NARROW_CHAT = 900;

function useWidth() {
  const [w, setW] = useState(viewportWidth());
  useEffect(() => {
    const on = () => setW(viewportWidth());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

/** `#home`, `#s/<lesson id>`, `#search` open a screen directly (handy for visual checks); `#settings/<section>` is read by useSettingsRoute. */
function initialHash() {
  const h = window.location.hash.replace("#", "");
  return h;
}

function TopBar({ sidebarVisible, onToggleSidebar, onNew, title }: { sidebarVisible: boolean; onToggleSidebar: () => void; onNew: () => void; title?: string }) {
  return (
    <header
      className="app-topbar drag chrome flex h-11 shrink-0 items-center px-3"
      style={{ paddingLeft: 12, paddingRight: 12 }}
    >
      {!sidebarVisible && (
        <div className="no-drag">
          <Tip label={t("Показать боковую панель")} hint="Ctrl \\">
            <IconButton variant="ghost" type="button" data-no-ripple aria-label={t("Показать боковую панель")} className={iconBtn} onClick={onToggleSidebar}>
              <SidebarSimple aria-hidden="true" className="size-4" />
            </IconButton>
          </Tip>
        </div>
      )}
      {title ? <h1 className="app-topbar-title">{title}</h1> : <span className="mobile-brand graphy-wordmark">Graphy</span>}
      <IconButton variant="ghost" className="mobile-new" aria-label={t("Новое занятие")} onClick={onNew}><NotePencil aria-hidden="true" /></IconButton>
    </header>
  );
}

function Workspace() {
  const hash = initialHash();
  const width = useWidth();
  const activeId = useStore((s) => s.activeId);
  const session = useSession(activeId);

  const [study, setStudy] = useState(hash === "study");
  const [school, setSchool] = useState(hash === "school");
  const [sidebarOpen, setSidebarOpen] = useState(viewportWidth() >= DOCK_SIDEBAR);
  const [searchOpen, setSearchOpen] = useState(hash === "search");
  // Settings are a page of their own in the address (#settings/<section>); the workspace below stays mounted while it is open
  const settings = useSettingsRoute();
  const appSettings = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const { open: openSettings, close: closeSettings } = settings;
  const backend = useBackend();
  const loaded = useRemote((r) => r.loaded);
  const ready = useRemote((r) => r.ready);
  // setup is offered when nothing can run yet (no model yet); «Пропустить» hides it until the next start
  const max = useMax();
  const maxRole = max.user?.role;
  const schoolAvailable = max.hub && (maxRole === "teacher" || maxRole === "student");
  useEffect(() => {
    if (!loaded) return;
    if (max.hub) { if (maxRole) void setTeacherMode(maxRole === "teacher").catch(() => undefined); } else void refreshRole();
  }, [loaded, max.hub, maxRole]);
  useEffect(() => (loaded && max.hub && maxRole === "student" ? startMaxLoops() : undefined), [loaded, max.hub, maxRole]);
  useEffect(() => {
    if (!loaded) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (n: number) => void };
    if (typeof w.requestIdleCallback === "function") {
      const id = w.requestIdleCallback(preloadScreens, { timeout: 400 });
      return () => w.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(preloadScreens, 400);
    return () => clearTimeout(id);
  }, [loaded]);
  const [setupForced, setSetupForced] = useState(false);
  const [setupSkipped, setSetupSkipped] = useState(false);
  const firstRun = !max.hub && loaded && (setupForced || (!setupSkipped && !ready));
  const setFirstRun = (open: boolean) => {
    setSetupForced(open);
    if (!open) setSetupSkipped(true);
  };

  const sidebarOverlay = width < DOCK_SIDEBAR;
  // the home grid drifts forever; it stands still whenever Home is covered (Settings, search, setup, the overlay sidebar) or the tab is hidden
  const [pageHidden, setPageHidden] = useState(document.hidden);
  const [dialogOpen, setDialogOpen] = useState(() => !!document.querySelector("[data-ui-dialog]"));
  useEffect(() => {
    const on = () => setPageHidden(document.hidden);
    document.addEventListener("visibilitychange", on);
    // modal dialogs (rename, delete, materials, sketch, ...) portal into <body> and cover Home without any App state changing
    const watch = new MutationObserver(() => setDialogOpen(!!document.querySelector("[data-ui-dialog]")));
    watch.observe(document.body, { childList: true });
    const settled = window.setTimeout(clearReloadFlag, 10000); // the start-up worked: a later stale chunk may reload again
    return () => { document.removeEventListener("visibilitychange", on); watch.disconnect(); clearTimeout(settled); };
  }, []);
  const panelOverlay = width < NARROW_CHAT;
  const view: View = study ? "study" : school && schoolAvailable ? "school" : session ? "lesson" : "home";
  useTrackViewing(view, activeId);
  const homeCovered = view !== "home" || settings.isOpen || searchOpen || firstRun || (sidebarOpen && sidebarOverlay) || dialogOpen || pageHidden;
  useEffect(() => {
    document.documentElement.toggleAttribute("data-home-paused", homeCovered);
    return () => document.documentElement.removeAttribute("data-home-paused");
  }, [homeCovered]);

  // the app talks to the agent as soon as the web server reports its connection settings
  useEffect(() => {
    if (backend.state === "ready" && backend.url && backend.token !== undefined) startSync(backend.url, backend.token);
    else stopSync();
  }, [backend.state, backend.url, backend.token]);

  // Follow the visible viewport when the phone keyboard opens, without disabling pinch zoom.
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      if (viewport && viewport.scale === 1) {
        const zoom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1; // layout px shrink with the page zoom
        document.documentElement.style.setProperty("--mobile-viewport-height", `${viewport.height / zoom}px`);
        document.documentElement.style.setProperty("--mobile-viewport-top", `${viewport.offsetTop / zoom}px`);
      }
    };
    resize();
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
    };
  }, []);

  // one-time deep link from the hash, once the lessons are known
  useEffect(() => {
    if (!loaded) return;
    if (hash.startsWith("s/") && getState().sessions[hash.slice(2)]) void openLesson(hash.slice(2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // crossing the breakpoint: an overlay sidebar starts closed, a docked one open
  useEffect(() => {
    setSidebarOpen(width >= DOCK_SIDEBAR);
  }, [sidebarOverlay]); // eslint-disable-line react-hooks/exhaustive-deps

  const openSession = useCallback((id: string) => {
    setStudy(false);
    setSchool(false);
    closeSettings();
    void openLesson(id);
    if (viewportWidth() < DOCK_SIDEBAR) setSidebarOpen(false);
  }, [closeSettings]);
  const openSchool = useCallback(() => {
    setSchool(true);
    setStudy(false);
    setSearchOpen(false);
    closeSettings();
    if (viewportWidth() < DOCK_SIDEBAR) setSidebarOpen(false);
  }, [closeSettings]);
  /** "New lesson" is the Today screen: nothing is created until the learner sends a goal. */
  const newLesson = useCallback(() => {
    setStudy(false);
    setSchool(false);
    setActive(null);
    setSearchOpen(false);
    closeSettings();
    if (viewportWidth() < DOCK_SIDEBAR) setSidebarOpen(false);
    if (!matchMedia("(pointer: coarse)").matches) requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-home-goal]')?.focus());
  }, [closeSettings]);

  useEffect(() => {
    if (!(sidebarOpen && sidebarOverlay)) return;
    const previous = document.activeElement as HTMLElement | null;
    const overlay = document.querySelector<HTMLElement>(".sidebar-overlay");
    const controls = () => [...(overlay?.querySelectorAll<HTMLElement>('md-list-item[type="button"], button, [tabindex="0"]') ?? [])].filter(el => el.getClientRects().length && !el.closest("[inert]"));
    controls()[0]?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (document.querySelector('[data-ui-dialog], [role="menu"], [role="listbox"], .ui-menu-content')) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSidebarOpen(false);
          }
      if (e.key === "Tab") {
        const items = controls();
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("keydown", key, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [sidebarOpen, sidebarOverlay]);

  // global shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (firstRun) return;
      // Escape leaves Settings (a phone: a section goes back to the list) unless a menu, dialog or tooltip inside owns it
      if (e.key === "Escape" && settingsRef.current.isOpen) {
        if (isImeKey(e) || e.defaultPrevented || (e.target as Element | null)?.closest?.("[data-keeps-escape]")) return;
        if (document.querySelector('[data-ui-dialog], .ui-menu-content, [role="menu"], [role="listbox"]')) return;
        e.preventDefault();
        if (isPhone() && settingsRef.current.section) settingsRef.current.up(); else settingsRef.current.close();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && !e.shiftKey && !e.altKey) {
        if (k === "n") (e.preventDefault(), newLesson());
        else if (k === "k") (e.preventDefault(), setSearchOpen(true));
        else if (k === "\\") (e.preventDefault(), setSidebarOpen((v) => !v));
        else if (k === ",") (e.preventDefault(), setSearchOpen(false), settingsRef.current.isOpen || openSettings());
        else if (k === "/") (e.preventDefault(), setSearchOpen(false), openSettings("keyboard"));
        return;
      }
      if (e.key === "F6") {
        e.preventDefault();
        if (document.querySelector('[data-ui-dialog]')) return;
        if (settingsRef.current.isOpen) {
          // Settings: the section list and the page itself
          const side = document.querySelector<HTMLElement>(".settings-side");
          const title = [...document.querySelectorAll<HTMLElement>("[data-settings-title]")].find((el) => el.getClientRects().length);
          const list = document.querySelector<HTMLElement>('.settings-nav md-list-item[data-aria-current="page"], .settings-nav md-list-item, .settings-nav input');
          (side?.contains(document.activeElement) ? title : list)?.focus();
          return;
        }
        // [where F6 lands, the area it belongs to]: the sidebar is entered at its main action, and focus anywhere inside it counts as being there
        const sidebar = document.querySelector<HTMLElement>("nav[data-sidebar]");
        const pick = (selector: string) => document.querySelector<HTMLElement>(selector);
        const areas: [HTMLElement | null, HTMLElement | null][] = [
          [pick("nav[data-sidebar] .new-lesson") ?? pick("nav[data-sidebar] md-list-item"), sidebar],
          [pick('[role="log"]'), null],
          [pick("[data-composer], [data-home-goal]"), null],
          [pick('[data-lesson-panel] [aria-expanded], [data-lesson-panel] [role="application"]'), null],
        ];
        const targets = areas.filter((a): a is [HTMLElement, HTMLElement | null] => !!a[0] && a[0].offsetParent !== null && !a[0].closest("[inert]"));
        if (!targets.length) return;
        const cur = targets.findIndex(([target, area]) => (area ?? target).contains(document.activeElement));
        const next = (cur + (e.shiftKey ? targets.length - 1 : 1)) % targets.length;
        targets[next][0].focus();
        return;
      }
      if (e.key === "Escape" && !isImeKey(e) && !e.defaultPrevented && !document.querySelector('[data-ui-dialog]')) {
        const id = getState().activeId;
        const s = id ? getState().sessions[id] : undefined;
        if (id && s && isBusy(s.agent)) stop(id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newLesson, firstRun, openSession, openSettings]);

  const sidebarDocked = sidebarOpen && !sidebarOverlay;
  const backLabel = view === "lesson" ? t("Назад к занятию") : view === "study" ? t("Назад к учёбе") : view === "school" ? t("Назад") : t("Назад на главную");
  const [handoff, setHandoff] = useState(false);
  const [gateGone, setGateGone] = useState(false);
  useEffect(() => {
    if (!loaded) { setHandoff(false); setGateGone(false); return; }
    let cancelled = false;
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    Promise.race([
      Promise.all([
        fonts?.ready ?? Promise.resolve(),
        new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))),
        new Promise(r => setTimeout(r, 120)), // settle layout (md upgrades / measurements)
      ]),
      new Promise(r => setTimeout(r, 900)),
    ]).then(() => { if (!cancelled) setHandoff(true); });
    const t = window.setTimeout(() => { if (!cancelled) setGateGone(true); }, 1300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [loaded]);

  if (!loaded) return <ConnectionGate />;

  const gate = gateGone ? null : <ConnectionGate fadeOut={handoff} />;

  return (
    <MotionConfig reducedMotion={appSettings.motion === "off" ? "always" : "user"}>
      <div className="workspace-handoff relative h-full w-full" data-ready={handoff}>
      {gate}
      <div className={`graphy-workspace relative flex h-full w-full overflow-hidden bg-paper font-sans text-ink `}>
        <OfflineBanner />
        <ToastHost />

        {!sidebarOverlay && (
          <div className="sidebar-dock h-full shrink-0" data-open={sidebarOpen} inert={!sidebarOpen || settings.isOpen}>
            <div className="sidebar-dock-inner">
            <Sidebar
              view={view}
              activeId={activeId}
              onNew={newLesson}
              onSearch={() => setSearchOpen(true)}
              onSchool={schoolAvailable ? openSchool : undefined}
              onOpen={openSession}
              onSettings={() => openSettings()}
              onToggle={() => setSidebarOpen(false)}
            />
            </div>
          </div>
        )}

        <main inert={(sidebarOpen && sidebarOverlay) || settings.isOpen} className="graphy-canvas relative flex min-w-0 flex-1 flex-col">
          {view === "lesson" && session ? (
            <>
              <SessionBar
                session={session}
                sidebarOpen={sidebarDocked}
                onToggleSidebar={() => setSidebarOpen(true)}
                padLeft={sidebarDocked ? 16 : 12}
                padRight={12}
              />
              <div className="lesson-body">
                <div className="lesson-chat">
                  <Thread session={session} onChooseModel={() => openSettings("general")} />
                  <Composer session={session} />
                </div>
                <Panel session={session} narrow={panelOverlay} />
              </div>
            </>
          ) : (
            <>
              <TopBar onNew={newLesson} sidebarVisible={sidebarDocked} onToggleSidebar={() => setSidebarOpen(true)} title={view === "study" ? t("Учёба") : view === "school" ? t("Школа") : undefined} />
              <div className="relative min-h-0 flex-1">
                {view === "study" ? (
                  <LazyBoundary><Suspense fallback={null}><StudyView onOpenLesson={openSession} /></Suspense></LazyBoundary>
                ) : view === "school" ? (
                  <LazyBoundary><Suspense fallback={null}><SchoolTab /></Suspense></LazyBoundary>
                ) : (
                  <Home onOpen={openSession} />
                )}
              </div>
            </>
          )}
        </main>

        {/* overlays for narrow windows */}
        {sidebarOverlay && (
          <div className="sidebar-overlay-layer" data-open={sidebarOpen} inert={!sidebarOpen}>
            <button type="button" aria-label={t("Закрыть боковую панель")} className="sidebar-backdrop absolute inset-0 z-30 cursor-default border-0 bg-black/32 p-0" onClick={() => setSidebarOpen(false)} />
            <div role="dialog" aria-modal="true" aria-label={t("Мои чаты")} className="sidebar-overlay absolute inset-y-0 left-0 z-40 shadow-pop" style={{ width: "var(--sb-w)" }}>
              <Sidebar
                view={view}
                activeId={activeId}
                onNew={newLesson}
                onSearch={() => (setSidebarOpen(false), setSearchOpen(true))}
                onSchool={schoolAvailable ? () => (setSidebarOpen(false), openSchool()) : undefined}
                onOpen={openSession}
                onSettings={() => (setSidebarOpen(false), openSettings())}
                onToggle={() => setSidebarOpen(false)}
              />
            </div>
          </div>
        )}
        {searchOpen && (
          <LazyBoundary><Suspense fallback={null}><SearchPalette
            onClose={() => setSearchOpen(false)}
            onOpen={openSession}
            onNew={newLesson}
            onSettings={() => openSettings()}
            onSchool={schoolAvailable ? openSchool : undefined}
            onSettingsSection={openSettings}
          /></Suspense></LazyBoundary>
        )}
        {settings.isOpen && (
          <LazyBoundary><Suspense fallback={null}><SettingsPage
            section={settings.section}
            onSection={openSettings}
            onUp={settings.up}
            onClose={closeSettings}
            backLabel={backLabel}
            onOpenLesson={openSession}
            onFirstRun={() => (closeSettings(), setFirstRun(true))}
          /></Suspense></LazyBoundary>
        )}
        {firstRun && <LazyBoundary><Suspense fallback={null}><FirstRun onDone={() => setFirstRun(false)} /></Suspense></LazyBoundary>}
      </div>
      </div>
    </MotionConfig>
  );
}

function Root() {
  const max = useMax();
  if (max.hub && max.status !== "ready") return <MaxGate />;
  if (max.hub && !max.user?.role) return <MaxGate />;
  return <Workspace />;
}
export default function App() { return <UIProvider><Root /></UIProvider>; }
