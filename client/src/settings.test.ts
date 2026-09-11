import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  adoptAiExtensionSettings,
  type AppSettings,
  type ExtensionSettingsValues,
} from "./settings";

// AI provider settings moved out of the ai-command / prompts extensions and
// into core (plans/core-ai-providers.md). These cover the adoption rules:
// customised values carry over, already-changed app settings never do, and
// the retired gemini CLI lands on agy.
describe("adoptAiExtensionSettings", () => {
  const ext = (values: Record<string, unknown>, id = "tmux-server.ai-command"): ExtensionSettingsValues => ({
    [id]: values,
  });

  it("adopts a customised provider from ai-command", () => {
    const next = adoptAiExtensionSettings(DEFAULT_SETTINGS, ext({ "aiCommand.provider": "codex" }));
    expect(next.aiProvider).toBe("codex");
  });

  it("maps the retired gemini CLI to agy", () => {
    const next = adoptAiExtensionSettings(DEFAULT_SETTINGS, ext({ "aiCommand.provider": "gemini" }));
    expect(next.aiProvider).toBe("agy");
  });

  it("reads the unnamespaced extension id too", () => {
    const next = adoptAiExtensionSettings(
      DEFAULT_SETTINGS,
      ext({ "aiCommand.provider": "codex" }, "ai-command"),
    );
    expect(next.aiProvider).toBe("codex");
  });

  it("adopts from prompts when ai-command has nothing", () => {
    const next = adoptAiExtensionSettings(
      DEFAULT_SETTINGS,
      ext({ "prompts.provider": "agy", "prompts.model": "gemini-3.8-flash-high" }, "tmux-server.prompts"),
    );
    expect(next.aiProvider).toBe("agy");
    expect(next.aiModel).toBe("gemini-3.8-flash-high");
  });

  it("lets ai-command win over prompts when both are customised", () => {
    const next = adoptAiExtensionSettings(DEFAULT_SETTINGS, {
      "tmux-server.ai-command": { "aiCommand.provider": "codex" },
      "tmux-server.prompts": { "prompts.provider": "agy" },
    });
    expect(next.aiProvider).toBe("codex");
  });

  it("never overwrites an app setting the user already changed", () => {
    const already: AppSettings = { ...DEFAULT_SETTINGS, aiProvider: "anthropic" };
    const next = adoptAiExtensionSettings(already, ext({ "aiCommand.provider": "codex" }));
    expect(next.aiProvider).toBe("anthropic");
  });

  it("ignores an unknown provider rather than adopting it", () => {
    const next = adoptAiExtensionSettings(DEFAULT_SETTINGS, ext({ "aiCommand.provider": "hal9000" }));
    expect(next.aiProvider).toBe(DEFAULT_SETTINGS.aiProvider);
  });

  it("carries binaryPath, model and customCommand across", () => {
    const next = adoptAiExtensionSettings(
      DEFAULT_SETTINGS,
      ext({
        "aiCommand.provider": "custom",
        "aiCommand.binaryPath": "/opt/bin/claude",
        "aiCommand.model": "haiku",
        "aiCommand.customCommand": "my-llm --quiet",
      }),
    );
    expect(next).toMatchObject({
      aiProvider: "custom",
      aiBinaryPath: "/opt/bin/claude",
      aiModel: "haiku",
      aiCustomCommand: "my-llm --quiet",
    });
  });

  it("ignores blank and non-string values", () => {
    const next = adoptAiExtensionSettings(
      DEFAULT_SETTINGS,
      ext({ "aiCommand.provider": "   ", "aiCommand.model": 42 }),
    );
    expect(next.aiProvider).toBe(DEFAULT_SETTINGS.aiProvider);
    expect(next.aiModel).toBe(DEFAULT_SETTINGS.aiModel);
  });

  // The bug this guards: adoption keyed off "value equals the default" re-ran
  // on every load, so an old extension setting of "custom" overwrote the
  // user's choice of "claude" on each reload — the default was unchoosable.
  it("adopts only while the document has never had aiProvider", () => {
    const ext = { "tmux-server.prompts": { "prompts.provider": "custom" } };
    // Never configured: the key is absent, so adoption runs.
    expect(adoptAiExtensionSettings(DEFAULT_SETTINGS, ext, {}).aiProvider).toBe("custom");
    // Configured once: the key exists, so adoption never runs again — even
    // when the stored value happens to equal the default.
    expect(
      adoptAiExtensionSettings(DEFAULT_SETTINGS, ext, { aiProvider: "claude" }).aiProvider,
    ).toBe("claude");
  });

  it("still adopts when no raw document is supplied", () => {
    const ext = { "tmux-server.prompts": { "prompts.provider": "codex" } };
    expect(adoptAiExtensionSettings(DEFAULT_SETTINGS, ext).aiProvider).toBe("codex");
  });

  it("is a no-op with no extension settings at all", () => {
    expect(adoptAiExtensionSettings(DEFAULT_SETTINGS, undefined)).toEqual(DEFAULT_SETTINGS);
    expect(adoptAiExtensionSettings(DEFAULT_SETTINGS, {})).toEqual(DEFAULT_SETTINGS);
  });
});
