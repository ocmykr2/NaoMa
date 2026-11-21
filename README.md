# Naoma

Naoma is an interactive reader for mathematical papers. Import a paper, tell it which ideas you already know, and follow the argument one section at a time. If a proof step feels opaque, you can ask for a worked example, try a simpler version of the problem, or remove an assumption and see where the reasoning breaks.

**[Download Naoma for Windows x64](https://github.com/ocmykr2/Naoma/releases/latest/download/Naoma-Windows-x64.zip)** · [All releases](https://github.com/ocmykr2/Naoma/releases)

## Run on Windows

1. Install Node.js 24 and make sure `node --version` works in a new terminal. The desktop window also uses the Microsoft Edge WebView2 Evergreen Runtime. [Node.js downloads](https://nodejs.org/en/download) · [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)
2. Install and sign in to the CLI for the AI provider you want to use. Naoma starts with Codex. For Claude, install the latest Claude Code (2.1.248 or newer), run `claude auth login` in a terminal, then choose **AI provider → Claude** in Naoma. Claude Code runs with `--model opus`, which tracks the latest Opus available through your configured provider. [Codex CLI](https://developers.openai.com/codex/cli/) · [Claude Code setup](https://code.claude.com/docs/en/setup) · [Claude model aliases](https://code.claude.com/docs/en/model-config)
3. For PDF import, install Poppler and put its tools on your `PATH`. Naoma uses `pdftotext`, `pdfinfo`, and `pdftoppm`. You can also paste a proof or import a text file. [Poppler](https://poppler.freedesktop.org/)
4. Allow about 2.6 GB for the extracted app and its Lean libraries. Extract the **entire** release ZIP into a short path such as `C:\Apps`, since Lean on Windows has a path-length limit. Open `proof-reader/start-reader.cmd` or double-click `proof-reader/desktop/Naoma.exe`. Keep the extracted folders together.

The first window offers an interval-scheduling example. Choose **Import paper** to start with your own material.

## Read a paper

1. **Choose your starting point.** After the first preparation, mark familiar proof techniques and definition groups. You can leave everything unmarked. Optionally supply a reference paper or paste a passage whose notation you like.
2. **Open the overview.** Naoma prepares a reading plan using those choices. Familiarity shortens background explanations. The paper’s own assumptions, notation and new arguments still need to be introduced.
3. **Explore a step.** Ask a question in your own words or use a suggested action. For example, in an exchange proof, ask “What is the smallest instance where the exchange changes the chosen schedule?” Follow a prerequisite link to revisit a definition or an earlier discussion.

Preparation progress is saved locally. If a preparation stops, open **Diagnostics** to see the job ID, stage and error code. These are useful when [reporting an issue](https://github.com/ocmykr2/Naoma/issues).

## Run from source

From the repository root, run the local service.

```sh
node proof-reader/server.cjs
```

Open <http://127.0.0.1:8794> in your browser. The server listens on the loopback interface. **AI provider** selects which CLI handles new paper research, reading plans, section explanations and follow-up questions. Your choice is saved on this computer. A job already in progress finishes with the provider it started with. When you opt in, relevant paper text, page images, reference passages and questions can be sent to that provider through your own account. Your library and reading progress are stored on your device.

On **macOS**, the source includes a browser-mode launch path. The Windows desktop build has been tested end to end. A native Mac app and end-to-end verification on a Mac are pending.

## How Naoma prepares a proof

- **Proof Craft** guides the model’s editorial review of each reading section. On first use, Naoma automatically downloads a pinned version of the four guidance files from the upstream repository and verifies their checksums. Later preparations reuse the local copy. [Proof Craft](https://github.com/fitelson/proof-craft)
- **Lean 4** runs automatically when a step has a supported formalization. The Windows x64 download includes the Lean 4.36.0 runtime. A Windows x64 checkout started from source can install the pinned runtime on first use. Browser mode on macOS or Linux can use a locally installed Lean 4. The reader shows the mathematical argument in English. This check applies to the individual steps that Naoma formalizes. [Lean 4](https://github.com/leanprover/lean4)

## Development

The application uses Node.js, a browser interface and a Windows WebView2 host. Run the test suite from the repository root.

```sh
node --test "proof-reader/*.test.cjs"
```

The Windows desktop build instructions are in the [desktop README](proof-reader/desktop/README.md). Distribution notices are included for [KaTeX](proof-reader/katex-LICENSE.txt) and [WebView2](proof-reader/desktop/WebView2-LICENSE.txt).
