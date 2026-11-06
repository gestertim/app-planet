"use client";

import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/language/css/monaco.contribution.js";
import "monaco-editor/language/html/monaco.contribution.js";
import "monaco-editor/language/typescript/monaco.contribution.js";
import Editor, { loader, type EditorProps } from "@monaco-editor/react";

loader.config({ monaco });

export default function ProjectMonacoEditor(props: EditorProps) {
  return <Editor {...props} />;
}
