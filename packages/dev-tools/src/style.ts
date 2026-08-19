/**
 * The panel's stylesheet, as a string the wiring site injects.
 *
 * In the package rather than the shell's `index.html` on purpose — and `verify:strip` is why: the
 * shell ships to production, and a `.devtools-*` rule sitting in it would be dev tooling in the
 * production page. Here, the styles are stripped with the code they style, by the same branch.
 *
 * The colour values mirror the shell's palette by convention rather than by custom property,
 * because this sheet must stand alone: it arrives after boot, into any host page.
 */
export const DEVTOOLS_CSS = `
.devtools-section {
  padding: 12px 0;
  border-bottom: 1px solid rgba(44, 56, 96, 0.5);
}

.devtools-section h3 {
  margin: 0 0 8px;
  font-size: 11px;
  letter-spacing: 0.14em;
  color: #8d97b8;
}

.devtools-section button {
  margin: 2px 6px 2px 0;
  padding: 6px 10px;
  border: 1px solid #2c3860;
  border-radius: 6px;
  background: rgba(16, 24, 48, 0.8);
  color: #e8ecf8;
  font: 600 11px/1 inherit;
  cursor: pointer;
}

.devtools-section button:focus-visible {
  outline: 2px solid #39d98a;
  outline-offset: 2px;
}

.devtools-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 4px 0;
  font-size: 12px;
  color: #8d97b8;
}

.devtools-field input,
.devtools-field select {
  width: 130px;
  padding: 4px 6px;
  border: 1px solid #2c3860;
  border-radius: 4px;
  background: #0b1020;
  color: #e8ecf8;
  font: inherit;
  font-size: 12px;
}

.devtools-note {
  margin: 4px 0;
  font-size: 11px;
  color: #e8b339;
  min-height: 1em;
}

.devtools-state,
.devtools-log {
  margin: 6px 0;
  padding: 8px;
  border: 1px solid rgba(44, 56, 96, 0.5);
  border-radius: 6px;
  background: #070b18;
  color: #e8ecf8;
  font-size: 11px;
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre;
}
`;
