import { describe, expect, it } from "vitest";

import { ghPassthroughArgs, hasBodyArg } from "./pr-passthrough.ts";

describe("gh passthrough args", () => {
  it("keeps the flags gh actually accepts", () => {
    const argv = ["--repo", "owner/repo", "--head", "claude/x", "--base", "main", "--title", "t", "--body-file", "/tmp/b.md"];

    expect(ghPassthroughArgs("create", argv)).toEqual(argv);
  });

  it("drops the wrapper-only branch-check flag instead of handing it to gh", () => {
    // The real failure: a green preflight followed by a bare `gh pr create` usage dump.
    expect(
      ghPassthroughArgs("create", ["--repo", "r/n", "--head", "claude/x", "--base", "main", "--no-remote-branch-check", "--title", "t"]),
    ).toEqual(["--repo", "r/n", "--head", "claude/x", "--base", "main", "--title", "t"]);
  });

  it("drops --head for edit, which gh pr edit rejects, but keeps --base, which it accepts", () => {
    expect(ghPassthroughArgs("edit", ["2823", "--repo", "r/n", "--head", "claude/x", "--base", "main", "--body-file", "/tmp/b.md"])).toEqual([
      "2823",
      "--repo",
      "r/n",
      "--base",
      "main",
      "--body-file",
      "/tmp/b.md",
    ]);
  });

  it("keeps --head for create, which gh pr create accepts", () => {
    expect(ghPassthroughArgs("create", ["--head", "claude/x"])).toEqual(["--head", "claude/x"]);
  });

  it("drops a valued flag written with = without eating the next token", () => {
    expect(ghPassthroughArgs("edit", ["2823", "--head=claude/x", "--base", "main"])).toEqual(["2823", "--base", "main"]);
  });

  it("never swallows a positional after a boolean flag", () => {
    // The branch-check flag takes no value, so the PR number after it must survive.
    expect(ghPassthroughArgs("edit", ["--no-remote-branch-check", "2823", "--repo", "r/n"])).toEqual(["2823", "--repo", "r/n"]);
    expect(ghPassthroughArgs("create", ["--json", "--title", "t"])).toEqual(["--title", "t"]);
  });

  it("leaves an unknown subcommand's args untouched rather than guessing", () => {
    expect(ghPassthroughArgs("view", ["--head", "claude/x"])).toEqual(["--head", "claude/x"]);
  });
});

describe("body arg detection", () => {
  it("spots every spelling of an explicit body so the wrapper does not append a second one", () => {
    expect(hasBodyArg(["--body-file", "/tmp/b.md"])).toBe(true);
    expect(hasBodyArg(["--body-file=/tmp/b.md"])).toBe(true);
    expect(hasBodyArg(["--body", "text"])).toBe(true);
    expect(hasBodyArg(["--body=text"])).toBe(true);
    expect(hasBodyArg(["-F", "/tmp/b.md"])).toBe(true);
    expect(hasBodyArg(["--title", "t"])).toBe(false);
  });
});
