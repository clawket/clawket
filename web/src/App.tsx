import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router';
import type { Project } from './types';
import api from './api';
import Sidebar from './components/Sidebar';
import PlanTree from './components/PlanTree';
import StepDetail from './components/StepDetail';
import PhaseDetail from './components/PhaseDetail';
import PlanDetail from './components/PlanDetail';
import CreatePhaseModal from './components/CreatePhaseModal';
import CreateStepModal from './components/CreateStepModal';
import CreatePlanModal from './components/CreatePlanModal';
import BoardView from './components/BoardView';
import BacklogView from './components/BacklogView';
import SummaryView from './components/SummaryView';
import TimelineView from './components/TimelineView';
import WikiView from './components/WikiView';

type ViewType = 'summary' | 'plans' | 'board' | 'backlog' | 'timeline' | 'wiki';
type SelectedItem =
  | { type: 'plan'; id: string }
  | { type: 'phase'; id: string }
  | { type: 'step'; id: string };

/** Parse the current URL pathname into project + view + optional detail item.
 *  URL format: /{projectId}/{view}  or  /{projectId}/{view}/{type}/{id}
 *  Legacy:     /{view}  (no project — uses selected project)
 *  Examples: /PROJ-xxx/plans, /PROJ-xxx/board/step/STEP-xxx
 */
function parseLocation(pathname: string): { projectId: string | null; view: ViewType; item: SelectedItem | null } {
  const parts = pathname.split('/').filter(Boolean);
  const VIEWS = new Set<ViewType>(['summary', 'plans', 'board', 'backlog', 'timeline', 'wiki']);

  // Check if first part is a project ID (starts with PROJ-)
  let projectId: string | null = null;
  let viewParts = parts;

  if (parts.length > 0 && parts[0].startsWith('PROJ-')) {
    projectId = parts[0];
    viewParts = parts.slice(1);
  }

  const view: ViewType = (VIEWS.has(viewParts[0] as ViewType) ? viewParts[0] : 'summary') as ViewType;

  // Detail: /{view}/{type}/{id}
  if (viewParts.length >= 3) {
    const [, type, id] = viewParts;
    if (type === 'step' || type === 'phase' || type === 'plan') {
      return { projectId, view, item: { type, id } };
    }
  }

  return { projectId, view, item: null };
}

function App() {
  const navigate = useNavigate();
  const location = useLocation();

  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [treeKey, setTreeKey] = useState(0);

  // Derive project, view, and selected item from URL
  const { projectId: urlProjectId, view: activeView, item: selectedItem } = parseLocation(location.pathname);

  // Sync URL project with selected project (avoid setState in effect)
  if (urlProjectId && urlProjectId !== selectedProjectId) {
    setSelectedProjectId(urlProjectId);
  }

  // Build URL prefix with project
  const urlPrefix = selectedProjectId ? `/${selectedProjectId}` : '';

  // Navigation helpers
  const setActiveView = useCallback((view: ViewType) => {
    navigate(`${urlPrefix}/${view}`);
  }, [navigate, urlPrefix]);

  const setSelectedItem = useCallback((item: SelectedItem | null) => {
    if (!item) {
      navigate(`${urlPrefix}/${activeView}`);
    } else {
      navigate(`${urlPrefix}/${activeView}/${item.type}/${item.id}`);
    }
  }, [navigate, activeView, urlPrefix]);

  // Redirect root to /summary (or /:projectId/summary)
  useEffect(() => {
    if (location.pathname === '/') {
      navigate('/summary', { replace: true });
    }
  }, [location.pathname, navigate]);

  // Drawer resize state
  const [drawerWidth, setDrawerWidth] = useState(() => {
    const saved = localStorage.getItem('lattice-drawer-width');
    return saved ? parseInt(saved, 10) : 520;
  });
  const isResizing = useRef(false);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = Math.max(360, Math.min(window.innerWidth * 0.9, window.innerWidth - e.clientX));
      setDrawerWidth(newWidth);
    };
    const handleMouseUp = () => {
      if (isResizing.current) {
        isResizing.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem('lattice-drawer-width', String(drawerWidth));
      }
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [drawerWidth]);

  function startResize() {
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  // Modal state
  const [createPlanForProject, setCreatePlanForProject] = useState<string | null>(null);
  const [createPhaseForPlan, setCreatePhaseForPlan] = useState<string | null>(null);
  const [createStepForPhase, setCreateStepForPhase] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listProjects().then((list) => {
      if (cancelled) return;
      setProjects(list);
      if (list.length > 0) {
        setSelectedProjectId((prev) => prev ?? list[0].id);
      }
    }).catch((err) => {
      console.error('Failed to load projects:', err);
    });
    return () => { cancelled = true; };
  }, []);

  // SSE: real-time updates from daemon
  useEffect(() => {
    const es = new EventSource('/events');
    const refresh = () => setTreeKey(k => k + 1);
    for (const evt of ['step:created', 'step:updated', 'step:deleted', 'phase:updated', 'plan:updated', 'bolt:updated']) {
      es.addEventListener(evt, refresh);
    }
    return () => es.close();
  }, []);

  function handleSelectProject(id: string) {
    setSelectedProjectId(id);
    navigate(`/${id}/${activeView}`);
  }

  function handleProjectCreated(project: Project) {
    setProjects((prev) => [...prev, project]);
    setSelectedProjectId(project.id);
    setSelectedItem(null);
  }

  function handleCreated() {
    setTreeKey((k) => k + 1);
  }

  return (
    <div className="flex h-full bg-background">
      {/* Left sidebar */}
      <Sidebar
        projects={projects}
        selectedId={selectedProjectId}
        onSelect={handleSelectProject}
        onProjectCreated={handleProjectCreated}
        activeView={activeView}
        onViewChange={setActiveView}
      />

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0">
        {selectedProjectId ? (
          <>
            {activeView === 'summary' && (
              <SummaryView
                key={`summary-${selectedProjectId}-${treeKey}`}
                projectId={selectedProjectId}
                onSelectStep={(id) => setSelectedItem({ type: 'step', id })}
              />
            )}
            {activeView === 'plans' && (
              <PlanTree
                key={`plans-${selectedProjectId}-${treeKey}`}
                projectId={selectedProjectId}
                selectedItem={selectedItem}
                onSelectItem={setSelectedItem}
                onCreatePlan={() => setCreatePlanForProject(selectedProjectId)}
                onCreatePhase={setCreatePhaseForPlan}
                onCreateStep={setCreateStepForPhase}
              />
            )}
            {activeView === 'board' && (
              <BoardView
                key={`board-${selectedProjectId}-${treeKey}`}
                projectId={selectedProjectId}
                onSelectStep={(id) => setSelectedItem({ type: 'step', id })}
              />
            )}
            {activeView === 'backlog' && (
              <BacklogView
                key={`backlog-${selectedProjectId}-${treeKey}`}
                projectId={selectedProjectId}
                onSelectStep={(id) => setSelectedItem({ type: 'step', id })}
              />
            )}
            {activeView === 'timeline' && (
              <TimelineView
                key={`timeline-${selectedProjectId}-${treeKey}`}
                projectId={selectedProjectId}
                onSelectStep={(id) => setSelectedItem({ type: 'step', id })}
              />
            )}
            {activeView === 'wiki' && (
              <WikiView key={`wiki-${selectedProjectId}-${treeKey}`} projectId={selectedProjectId} />
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted">
            <div className="text-center">
              <div className="text-2xl mb-2">Lattice</div>
              <div className="text-sm">Select a project to get started</div>
            </div>
          </div>
        )}
      </main>

      {/* Detail drawer (overlay) */}
      {selectedItem && (
        <>
          <div
            className="fixed inset-0 bg-overlay z-40 transition-opacity"
            onClick={() => setSelectedItem(null)}
          />
          <div
            className="fixed top-0 right-0 h-full max-w-[90vw] z-50 shadow-2xl border-l border-border animate-slide-in flex"
            style={{ width: `${drawerWidth}px` }}
          >
            {/* Resize handle */}
            <div
              className="w-1 hover:w-1.5 cursor-col-resize bg-transparent hover:bg-primary/30 transition-colors shrink-0"
              onMouseDown={startResize}
            />
            <div className="flex-1 min-w-0">
              {selectedItem.type === 'step' && (
                <StepDetail stepId={selectedItem.id} projectId={selectedProjectId ?? undefined} onClose={() => setSelectedItem(null)} />
              )}
              {selectedItem.type === 'phase' && (
                <PhaseDetail phaseId={selectedItem.id} onClose={() => setSelectedItem(null)} />
              )}
              {selectedItem.type === 'plan' && (
                <PlanDetail planId={selectedItem.id} onClose={() => setSelectedItem(null)} />
              )}
            </div>
          </div>
        </>
      )}

      {/* Modals */}
      {createPlanForProject && (
        <CreatePlanModal
          projectId={createPlanForProject}
          onClose={() => setCreatePlanForProject(null)}
          onCreated={handleCreated}
        />
      )}
      {createPhaseForPlan && (
        <CreatePhaseModal
          planId={createPhaseForPlan}
          onClose={() => setCreatePhaseForPlan(null)}
          onCreated={handleCreated}
        />
      )}
      {createStepForPhase && (
        <CreateStepModal
          phaseId={createStepForPhase}
          onClose={() => setCreateStepForPhase(null)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}

export default App;
