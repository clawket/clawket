import { useState, useCallback } from 'react';
import type { Project } from '../types';
import api from '../api';

export function ProjectSettings({
  project,
  projectId,
  onProjectChange,
}: {
  project: Project;
  projectId: string;
  onProjectChange: () => Promise<unknown>;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [descValue, setDescValue] = useState('');
  const [newCwd, setNewCwd] = useState('');

  const saveName = useCallback(async () => {
    if (!nameValue.trim()) return;
    await api.updateProject(projectId, { name: nameValue.trim() });
    await onProjectChange();
    setEditingName(false);
  }, [projectId, nameValue, onProjectChange]);

  const saveDesc = useCallback(async () => {
    await api.updateProject(projectId, { description: descValue.trim() || null as unknown as string });
    await onProjectChange();
    setEditingDesc(false);
  }, [projectId, descValue, onProjectChange]);

  const addCwd = useCallback(async () => {
    if (!newCwd.trim()) return;
    await api.addProjectCwd(projectId, newCwd.trim());
    setNewCwd('');
    await onProjectChange();
  }, [projectId, newCwd, onProjectChange]);

  return (
    <div className="bg-surface rounded-lg border border-border">
      <button
        onClick={() => setSettingsOpen(o => !o)}
        className="w-full text-left px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-surface-hover transition-colors rounded-lg"
      >
        <h3 className="text-sm font-medium text-foreground">Project Settings</h3>
        <span className="text-xs text-muted">{settingsOpen ? '\u25B2' : '\u25BC'}</span>
      </button>

      {settingsOpen && (
        <div className="px-4 pb-4 space-y-4 border-t border-border pt-4">
          {/* Name */}
          <div>
            <label className="text-xs text-muted block mb-1">Name</label>
            {editingName ? (
              <div className="flex gap-2">
                <input
                  className="flex-1 bg-background border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
                  value={nameValue}
                  onChange={e => setNameValue(e.target.value)}
                  autoFocus
                  onKeyDown={e => { if (e.key === 'Enter') saveName(); else if (e.key === 'Escape') setEditingName(false); }}
                />
                <button onClick={saveName} className="px-2 py-1 text-xs bg-primary text-white rounded hover:bg-primary/80 cursor-pointer">Save</button>
                <button onClick={() => setEditingName(false)} className="px-2 py-1 text-xs text-muted hover:text-foreground cursor-pointer">Cancel</button>
              </div>
            ) : (
              <button onClick={() => { setNameValue(project.name); setEditingName(true); }} className="text-sm text-foreground hover:text-primary cursor-pointer">
                {project.name}
              </button>
            )}
          </div>

          {/* Description */}
          <div>
            <label className="text-xs text-muted block mb-1">Description</label>
            {editingDesc ? (
              <div className="flex gap-2">
                <input
                  className="flex-1 bg-background border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
                  value={descValue}
                  onChange={e => setDescValue(e.target.value)}
                  placeholder="Project description"
                  autoFocus
                  onKeyDown={e => { if (e.key === 'Enter') saveDesc(); else if (e.key === 'Escape') setEditingDesc(false); }}
                />
                <button onClick={saveDesc} className="px-2 py-1 text-xs bg-primary text-white rounded hover:bg-primary/80 cursor-pointer">Save</button>
                <button onClick={() => setEditingDesc(false)} className="px-2 py-1 text-xs text-muted hover:text-foreground cursor-pointer">Cancel</button>
              </div>
            ) : (
              <button onClick={() => { setDescValue(project.description || ''); setEditingDesc(true); }} className="text-sm text-foreground hover:text-primary cursor-pointer">
                {project.description || <span className="text-muted italic">No description</span>}
              </button>
            )}
          </div>

          {/* Working Directories */}
          <div>
            <label className="text-xs text-muted block mb-1">Working Directories</label>
            <div className="space-y-1.5">
              {project.cwds.map(cwd => (
                <div key={cwd} className="flex items-center gap-2 group">
                  <span className="text-xs font-mono text-foreground bg-surface-high rounded px-2 py-1 flex-1 truncate" title={cwd}>{cwd}</span>
                  <button
                    onClick={async () => { await api.removeProjectCwd(projectId, cwd); await onProjectChange(); }}
                    className="text-xs text-muted hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer px-1"
                    title="Remove"
                  >&times;</button>
                </div>
              ))}
              {project.cwds.length === 0 && <div className="text-xs text-muted italic">No working directories</div>}
            </div>
            <div className="flex gap-2 mt-2">
              <input
                className="flex-1 bg-background border border-border rounded px-2 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary"
                value={newCwd}
                onChange={e => setNewCwd(e.target.value)}
                placeholder="/path/to/project"
                onKeyDown={e => { if (e.key === 'Enter') addCwd(); }}
              />
              <button onClick={addCwd} className="px-2 py-1 text-xs bg-primary text-white rounded hover:bg-primary/80 cursor-pointer">Add</button>
            </div>
          </div>

          {/* Project ID */}
          <div>
            <label className="text-xs text-muted block mb-1">Project ID</label>
            <span className="text-xs font-mono text-muted">{project.id}</span>
          </div>
        </div>
      )}
    </div>
  );
}
