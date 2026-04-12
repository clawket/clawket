import { useState, useEffect } from 'react';
import type { Project } from '../types';
import api from '../api';
import { Button, Input } from './ui';

function SunIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function useTheme() {
  const [theme, setThemeState] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('lattice-theme') as 'dark' | 'light') || 'dark';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('lattice-theme', theme);
  }, [theme]);

  const toggle = () => setThemeState(t => t === 'dark' ? 'light' : 'dark');
  return { theme, toggle };
}

interface SidebarProps {
  projects: Project[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onProjectCreated: (project: Project) => void;
  activeView: 'summary' | 'plans' | 'board' | 'backlog' | 'timeline' | 'wiki';
  onViewChange: (view: 'summary' | 'plans' | 'board' | 'backlog' | 'timeline' | 'wiki') => void;
}

const viewNavItems: { key: 'summary' | 'plans' | 'board' | 'backlog' | 'timeline' | 'wiki'; icon: string; label: string }[] = [
  { key: 'summary', icon: '\u25A3', label: 'Summary' },
  { key: 'plans', icon: '\u2261', label: 'Plans' },
  { key: 'board', icon: '\u229E', label: 'Board' },
  { key: 'backlog', icon: '\u2630', label: 'Backlog' },
  { key: 'timeline', icon: '\u23F1', label: 'Timeline' },
  { key: 'wiki', icon: '\u2263', label: 'Wiki' },
];

export default function Sidebar({ projects, selectedId, onSelect, onProjectCreated, activeView, onViewChange }: SidebarProps) {
  const { theme, toggle: toggleTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem('lattice-sidebar-collapsed') === 'true';
  });
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCwd, setNewCwd] = useState('');

  function toggleCollapse() {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem('lattice-sidebar-collapsed', String(next));
      return next;
    });
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    try {
      const project = await api.createProject({
        name: newName.trim(),
        cwd: newCwd.trim() || undefined,
      });
      onProjectCreated(project);
      setNewName('');
      setNewCwd('');
      setCreating(false);
    } catch (err) {
      console.error('Failed to create project:', err);
    }
  }

  if (collapsed) {
    return (
      <aside className="w-12 shrink-0 bg-surface border-r border-border flex flex-col h-full">
        {/* Expand button */}
        <div className="px-2 py-3 border-b border-border flex justify-center">
          <button
            onClick={toggleCollapse}
            className="text-muted hover:text-foreground transition-colors cursor-pointer"
            title="Expand sidebar"
          >
            {'\u25B6'}
          </button>
        </div>

        {/* Project icons */}
        <div className="flex-1 overflow-y-auto py-2 space-y-1">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => onSelect(p.id)}
              title={p.name}
              className={`w-full flex justify-center py-2 transition-colors cursor-pointer ${
                selectedId === p.id
                  ? 'text-primary bg-primary/15'
                  : 'text-muted hover:text-foreground hover:bg-surface-hover'
              }`}
            >
              <span className="text-xs font-bold">{p.name.charAt(0).toUpperCase()}</span>
            </button>
          ))}
        </div>

        {/* View icons */}
        <nav className="border-t border-border py-1">
          {viewNavItems.map((item) => (
            <button
              key={item.key}
              onClick={() => onViewChange(item.key)}
              title={item.label}
              className={`w-full flex justify-center py-2 transition-colors cursor-pointer ${
                activeView === item.key
                  ? 'text-primary bg-primary/15'
                  : 'text-muted hover:text-foreground hover:bg-surface-hover'
              }`}
            >
              <span>{item.icon}</span>
            </button>
          ))}
        </nav>

        {/* Theme toggle */}
        <div className="border-t border-border py-2 flex justify-center">
          <button
            onClick={toggleTheme}
            className="text-muted hover:text-foreground transition-colors cursor-pointer"
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-60 shrink-0 bg-surface border-r border-border flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h1 className="text-sm font-semibold text-foreground tracking-wide uppercase flex items-center gap-2">
          <svg width="18" height="18" viewBox="0 0 128 128" fill="none">
            <rect width="128" height="128" rx="24" fill="currentColor" opacity="0.15"/>
            <line x1="32" y1="28" x2="32" y2="100" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity="0.4"/>
            <line x1="64" y1="28" x2="64" y2="100" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity="0.4"/>
            <line x1="96" y1="28" x2="96" y2="100" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity="0.4"/>
            <line x1="20" y1="40" x2="108" y2="40" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity="0.4"/>
            <line x1="20" y1="64" x2="108" y2="64" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity="0.4"/>
            <line x1="20" y1="88" x2="108" y2="88" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity="0.4"/>
            <circle cx="32" cy="40" r="6" fill="currentColor"/><circle cx="64" cy="40" r="6" fill="currentColor"/>
            <circle cx="96" cy="40" r="6" fill="#22c55e"/><circle cx="32" cy="64" r="6" fill="currentColor"/>
            <circle cx="64" cy="64" r="6" fill="#f59e0b"/><circle cx="96" cy="64" r="6" fill="currentColor"/>
            <circle cx="32" cy="88" r="6" fill="#22c55e"/><circle cx="64" cy="88" r="6" fill="#22c55e"/>
            <circle cx="96" cy="88" r="6" fill="currentColor"/>
          </svg>
          Lattice
        </h1>
        <button
          onClick={toggleCollapse}
          className="text-muted hover:text-foreground transition-colors cursor-pointer text-xs"
          title="Collapse sidebar"
        >
          {'\u25C0'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {projects.map((p) => (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            className={`w-full text-left px-4 py-2.5 transition-colors ${
              selectedId === p.id
                ? 'bg-primary/15 text-primary border-l-2 border-primary'
                : 'text-foreground hover:bg-surface-hover border-l-2 border-transparent'
            }`}
          >
            <div className="text-sm font-medium truncate">{p.name}</div>
            {p.cwds.length > 0 && (
              <div className="text-xs text-muted truncate mt-0.5" title={p.cwds[0]}>
                {p.cwds[0].split('/').slice(-2).join('/')}
              </div>
            )}
          </button>
        ))}
        {projects.length === 0 && (
          <div className="px-4 py-6 text-center text-muted text-sm">No projects yet</div>
        )}
      </div>

      <nav className="border-t border-border py-1">
        {viewNavItems.map((item) => (
          <button
            key={item.key}
            onClick={() => onViewChange(item.key)}
            className={`w-full text-left px-4 py-2 text-sm transition-colors ${
              activeView === item.key
                ? 'bg-primary/15 text-primary border-l-2 border-primary'
                : 'text-foreground hover:bg-surface-hover border-l-2 border-transparent'
            }`}
          >
            <span className="mr-2">{item.icon}</span>{item.label}
          </button>
        ))}
      </nav>

      <div className="border-t border-border p-3">
        {creating ? (
          <div className="space-y-2">
            <Input
              size="sm"
              type="text"
              placeholder="Project name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false); }}
            />
            <Input
              size="sm"
              type="text"
              placeholder="Working directory (optional)"
              value={newCwd}
              onChange={(e) => setNewCwd(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false); }}
            />
            <div className="flex gap-2">
              <Button variant="primary" size="sm" className="flex-1" onClick={handleCreate}>
                Create
              </Button>
              <Button variant="outline" size="sm" className="flex-1" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="w-full border border-dashed border-border hover:border-primary"
            onClick={() => setCreating(true)}
          >
            + New Project
          </Button>
        )}
      </div>

      {/* Theme toggle */}
      <div className="border-t border-border px-3 py-2">
        <button
          onClick={toggleTheme}
          className="w-full text-xs text-muted hover:text-foreground py-1.5 rounded transition-colors flex items-center justify-center gap-2 cursor-pointer"
        >
          {theme === 'dark' ? <><SunIcon /> Light</> : <><MoonIcon /> Dark</>}
        </button>
      </div>
    </aside>
  );
}
