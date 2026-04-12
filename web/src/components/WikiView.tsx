import { useState, useEffect, useCallback } from 'react';
import Markdown from 'react-markdown';
import type { Artifact, ArtifactVersion, Plan } from '../types';
import api from '../api';
import type { WikiFile } from '../api';
import { Button, Modal, Input, Textarea, Select, Label } from './ui';

interface WikiViewProps {
  projectId: string;
}

interface FileEntry {
  type: 'file';
  path: string;
  name: string;
  modified_at: number;
}

interface ArtifactNode extends Artifact {
  children: ArtifactNode[];
}

function buildTree(artifacts: Artifact[]): ArtifactNode[] {
  const map = new Map<string, ArtifactNode>();
  const roots: ArtifactNode[] = [];

  for (const a of artifacts) {
    map.set(a.id, { ...a, children: [] });
  }

  for (const node of map.values()) {
    const parentId = (node as unknown as { parent_id?: string }).parent_id;
    if (parentId && map.has(parentId)) {
      map.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function TreeItem({
  node,
  selectedId,
  onSelect,
  depth = 0,
}: {
  node: ArtifactNode;
  selectedId: string | null;
  onSelect: (id: string) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <button
        onClick={() => onSelect(node.id)}
        className={`w-full text-left py-1.5 px-2 rounded-md text-sm transition-colors flex items-center gap-1.5 cursor-pointer ${
          selectedId === node.id
            ? 'bg-primary/15 text-primary'
            : 'text-foreground hover:bg-surface-hover'
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {hasChildren && (
          <span
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="w-4 text-center text-muted hover:text-foreground cursor-pointer"
          >
            {expanded ? '\u25BE' : '\u25B8'}
          </span>
        )}
        {!hasChildren && <span className="w-4" />}
        <span className="text-xs text-muted mr-1">
          {node.content_format === 'markdown' ? '\u2263' : node.content_format === 'json' ? '{}' : '\u2261'}
        </span>
        <span className="truncate">{node.title}</span>
      </button>
      {expanded && hasChildren && (
        <div>
          {node.children.map(child => (
            <TreeItem
              key={child.id}
              node={child}
              selectedId={selectedId}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ContentRenderer({ content, format }: { content: string; format: string }) {
  if (format === 'json' || format === 'yaml') {
    return (
      <pre className="bg-surface-high rounded-lg p-4 text-sm text-foreground overflow-x-auto font-mono whitespace-pre-wrap">
        {content}
      </pre>
    );
  }

  return (
    <div className="prose prose-sm max-w-none">
      <Markdown>{content}</Markdown>
    </div>
  );
}

function VersionHistory({
  artifactId,
  onRestore,
}: {
  artifactId: string;
  onRestore: (content: string) => void;
}) {
  const [versions, setVersions] = useState<ArtifactVersion[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.fetchArtifactVersions(artifactId)
      .then(setVersions)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [artifactId]);

  if (loading) return <div className="text-xs text-muted py-2">Loading versions...</div>;
  if (versions.length === 0) return <div className="text-xs text-muted py-2">No version history</div>;

  return (
    <div className="space-y-1">
      {versions.map(v => (
        <div key={v.id} className="flex items-center justify-between text-xs px-2 py-1.5 rounded hover:bg-surface-hover">
          <div className="flex items-center gap-2">
            <span className="text-muted">v{v.version}</span>
            <span className="text-foreground">
              {v.created_at ? new Date(v.created_at).toLocaleString() : '-'}
            </span>
            {v.created_by && <span className="text-muted">by {v.created_by}</span>}
          </div>
          {v.content && (
            <button
              onClick={() => onRestore(v.content!)}
              className="text-primary hover:underline cursor-pointer"
            >
              Restore
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export default function WikiView({ projectId }: WikiViewProps) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<WikiFile | null>(null);
  const [projectCwd, setProjectCwd] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showVersions, setShowVersions] = useState(false);

  // Create form state
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newFormat, setNewFormat] = useState('markdown');
  const [newType, setNewType] = useState('document');

  const selected = artifacts.find(a => a.id === selectedId) || null;

  const loadArtifacts = useCallback(async () => {
    try {
      const [planList, project] = await Promise.all([
        api.listPlans({ project_id: projectId }),
        api.getProject(projectId),
      ]);
      setPlans(planList);
      const cwd = project?.cwds?.[0] || null;
      setProjectCwd(cwd);

      // Load artifacts for all plans
      const results = await Promise.all(
        planList.map(p => api.listArtifacts({ plan_id: p.id }))
      );
      setArtifacts(results.flat());

      // Load project files
      if (cwd) {
        try {
          const wikiFiles = await api.listWikiFiles(cwd);
          setFiles(wikiFiles.map(f => ({ type: 'file' as const, path: f.path, name: f.name, modified_at: f.modified_at })));
        } catch { setFiles([]); }
      }
    } catch (err) {
      console.error('Failed to load artifacts:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    loadArtifacts();
  }, [loadArtifacts]);

  async function handleCreate() {
    if (!newTitle.trim()) return;
    try {
      const planId = plans[0]?.id;
      if (!planId) return;
      await api.createArtifact({
        plan_id: planId,
        type: newType,
        title: newTitle.trim(),
        content: newContent,
        content_format: newFormat,
      });
      setShowCreate(false);
      setNewTitle('');
      setNewContent('');
      await loadArtifacts();
    } catch (err) {
      console.error('Failed to create artifact:', err);
    }
  }

  async function handleSelectFile(path: string) {
    setSelectedId(null);
    setSelectedFile(path);
    if (projectCwd) {
      try {
        const file = await api.getWikiFile(projectCwd, path);
        setFileContent(file);
      } catch (err) {
        console.error('Failed to load file:', err);
        setFileContent(null);
      }
    }
  }

  function handleSelectArtifact(id: string) {
    setSelectedFile(null);
    setFileContent(null);
    setSelectedId(id);
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteArtifact(id);
      setSelectedId(null);
      await loadArtifacts();
    } catch (err) {
      console.error('Failed to delete artifact:', err);
    }
  }

  const tree = buildTree(artifacts);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted">
        Loading wiki...
      </div>
    );
  }

  return (
    <div className="flex-1 flex min-h-0">
      {/* Sidebar - artifact tree */}
      <div className="w-64 shrink-0 border-r border-border flex flex-col">
        <div className="px-3 py-2.5 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-medium text-foreground">Wiki</h3>
          <Button variant="ghost" size="sm" onClick={() => setShowCreate(true)}>
            + New
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto py-1 px-1">
          {/* Artifacts section */}
          {tree.length > 0 && (
            <div className="mb-2">
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted font-medium">Artifacts</div>
              {tree.map(node => (
                <TreeItem
                  key={node.id}
                  node={node}
                  selectedId={selectedId}
                  onSelect={handleSelectArtifact}
                />
              ))}
            </div>
          )}
          {/* Project files section */}
          {files.length > 0 && (
            <div>
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted font-medium">Project Files</div>
              {files.map(f => (
                <button
                  key={f.path}
                  onClick={() => handleSelectFile(f.path)}
                  className={`w-full text-left py-1.5 px-2 rounded-md text-sm transition-colors flex items-center gap-1.5 cursor-pointer ${
                    selectedFile === f.path
                      ? 'bg-primary/15 text-primary'
                      : 'text-foreground hover:bg-surface-hover'
                  }`}
                >
                  <span className="text-xs text-muted">{'\u2263'}</span>
                  <span className="truncate">{f.path}</span>
                </button>
              ))}
            </div>
          )}
          {tree.length === 0 && files.length === 0 && (
            <div className="text-center py-6 text-xs text-muted">
              No documents yet
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {selected ? (
          <div className="p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-xl font-semibold text-foreground">{selected.title}</h2>
                <div className="flex items-center gap-3 mt-1 text-xs text-muted">
                  <span>{selected.type}</span>
                  <span>{selected.content_format}</span>
                  <span>{new Date(selected.created_at).toLocaleDateString()}</span>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowVersions(!showVersions)}
                >
                  {showVersions ? 'Hide History' : 'History'}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => handleDelete(selected.id)}
                >
                  Delete
                </Button>
              </div>
            </div>

            {showVersions && (
              <div className="mb-4 bg-surface rounded-lg border border-border p-3">
                <h4 className="text-xs font-medium text-foreground mb-2">Version History</h4>
                <VersionHistory
                  artifactId={selected.id}
                  onRestore={(content) => {
                    // For now, just log - full edit flow would be more complex
                    console.log('Restore content:', content.slice(0, 100));
                  }}
                />
              </div>
            )}

            <div className="bg-surface rounded-lg border border-border p-6">
              <ContentRenderer content={selected.content} format={selected.content_format} />
            </div>
          </div>
        ) : fileContent ? (
          <div className="p-6">
            <div className="mb-4">
              <h2 className="text-xl font-semibold text-foreground">{fileContent.name}</h2>
              <div className="flex items-center gap-3 mt-1 text-xs text-muted">
                <span>{fileContent.path}</span>
                <span>{fileContent.content_format}</span>
                {fileContent.modified_at && (
                  <span>{new Date(fileContent.modified_at).toLocaleDateString()}</span>
                )}
              </div>
            </div>
            <div className="bg-surface rounded-lg border border-border p-6">
              <ContentRenderer content={fileContent.content || ''} format={fileContent.content_format || 'markdown'} />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center h-full text-muted text-sm">
            Select a document from the sidebar
          </div>
        )}
      </div>

      {/* Create modal */}
      {showCreate && (
        <Modal.Overlay onClose={() => setShowCreate(false)}>
          <Modal.Content>
            <Modal.Header>New Artifact</Modal.Header>
            <Modal.Body>
              <div>
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Artifact title"
                  autoFocus
                />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <Label htmlFor="type">Type</Label>
                  <Select
                    id="type"
                    value={newType}
                    onChange={(e) => setNewType(e.target.value)}
                  >
                    <option value="document">Document</option>
                    <option value="decision">Decision</option>
                    <option value="wireframe">Wireframe</option>
                    <option value="api_spec">API Spec</option>
                    <option value="schema">Schema</option>
                  </Select>
                </div>
                <div className="flex-1">
                  <Label htmlFor="format">Format</Label>
                  <Select
                    id="format"
                    value={newFormat}
                    onChange={(e) => setNewFormat(e.target.value)}
                  >
                    <option value="markdown">Markdown</option>
                    <option value="json">JSON</option>
                    <option value="yaml">YAML</option>
                  </Select>
                </div>
              </div>
              <div>
                <Label htmlFor="content">Content</Label>
                <Textarea
                  id="content"
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder="Write content..."
                  rows={10}
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
                <Button variant="primary" onClick={handleCreate}>Create</Button>
              </div>
            </Modal.Body>
          </Modal.Content>
        </Modal.Overlay>
      )}
    </div>
  );
}
