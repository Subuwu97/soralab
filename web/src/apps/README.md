# SoraLab editors

Each app lives in `src/apps/<id>/` and its `index.jsx` default-exports the editor component. It's loaded only when
someone opens `/<id>/<project id>` (see `App.jsx`). The `id` must match an entry in `src/lib/apps.js`.

```jsx
export default function PhotoEditor({ id }) {
  const project = useProject(id);            // lib/doc.js — metadata + saved contents + save()
  const h = useHistory(null);                // lib/history.js — undo/redo; keep the whole document in it
  useEffect(() => { if (project.data !== undefined) h.reset(fromSaved(project.data, project.doc)); }, [project.data]);
  return (
    <EditorShell app="photo" project={project} history={h}
      getData={async () => ({ data: toSaved(h.state), thumb: canvas, width, height })}
      menus={[...]} tools={...} options={...} panels={...} exportConfig={{ formats, render }}>
      <Workspace />
    </EditorShell>
  );
}
```

## Rules of the road

- **New projects** arrive with `project.data` = `{}` (or whatever the New screen passed) and the size and settings in
  `project.doc` (`width`, `height`, `duration`, `pages`, `meta` — e.g. `meta.fps`, `meta.sampleRate`, `meta.template`).
  Build a sensible empty document from those.
- **Saving**: the shell autosaves 1.5 s after the history changes (and on Ctrl/⌘+S and before leaving). `getData()`
  returns `{ data, thumb?, width?, height?, duration?, pages?, meta? }`. `data` is JSON (preferred) or a Blob. Keep it
  small: pixels and media are **assets** (`saveBlob()` / `uploadFiles()` / `pickAssets()`), referenced by asset id.
  `thumb` is a canvas or Blob for project lists.
- **Read-only**: when `project.canEdit` is false, don't change the document (viewers and commenters can still look,
  zoom, play, and comment).
- **Media**: draw/play assets with `assetSrc(asset)` (the browser-friendly copy). `GET /api/assets/:id/frame?t=&w=`
  gives a video frame; `/peaks?n=` a waveform.
- **Export**: `exportConfig = { formats, render(formatId, options, { onProgress }) }`. `render` returns a Blob made in
  the browser, or `{ job: { kind: 'timeline' | 'transcode', spec } }` to render on the server with ffmpeg (see
  `server/src/render.js` for the timeline spec). The dialog handles download / Files / Minami Cloud / Tsunami.
- **UI kit**: `components/ui.jsx` (Button, IconButton, Slider, NumberInput, Select, Segmented, Toggle, ColorSwatch,
  ColorPicker, PanelSection, Popover, openMenu, Modal, confirmDialog/promptDialog, toast…), `components/Icons.jsx`,
  `components/Pickers.jsx` (pickAssets, pickCloudFiles, FontPicker, WeightPicker), `lib/fonts.js` (ensureFont, fontData),
  `lib/color.js`, `lib/shortcuts.js` (useShortcuts, keyLabel). Use the theme colours (`bg-panel`, `bg-panel-2`,
  `bg-work`, `text-fg`, `text-fg2`, `border-line`, `bg-hover`, `bg-active`, `text-accent`…).
- **Libraries**: `useApp().libraries` (colours, styles, graphics…) and `POST /api/libraries/:id/items` to add to them.
- Keyboard shortcuts should follow the familiar ones of the app each editor is modelled on.
