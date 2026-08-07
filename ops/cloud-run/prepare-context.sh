#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository_root=$(git -C "$script_dir" rev-parse --show-toplevel)
context_dir=${1:-}
[[ "$context_dir" == /tmp/* ]] || { echo "usage: $0 /tmp/exact-build-context" >&2; exit 64; }
mkdir -p "$context_dir/lib/emsenn/services/561-group/services/engineering-services-section/services/computer-services-section/services/web-services-section"

package_relative=${script_dir#"$repository_root/"}
package_relative=${package_relative%/ops/cloud-run}
git -C "$repository_root" cat-file -e "HEAD:${package_relative}/package-lock.json" \
  || { echo "committed package-lock.json is required for the exact build closure" >&2; exit 65; }
records_path=$(mktemp "$context_dir/git-object-closure-records.XXXXXXXX")
node --input-type=module - "$repository_root" "$package_relative" > "$records_path" <<'NODE'
import { execFileSync } from "node:child_process";
import path from "node:path";
const [repositoryRoot, initial] = process.argv.slice(2), queue = [initial], seen = new Set();
const git = (repository, args) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });
function checkedRelative(value) {
  const relative = path.posix.normalize(value);
  if (relative === "." || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw new Error(`file dependency escapes the Git-object build territory: ${value}`);
  }
  return relative;
}
function treeEntry(repository, revision, candidate) {
  const line = git(repository, ["ls-tree", revision, "--", candidate]).trim();
  if (line === "") throw new Error(`Git object ${revision}:${candidate} is absent from ${repository}`);
  const [metadata] = line.split("\t", 1), [mode, , oid] = metadata.split(/\s+/u);
  return { mode, oid };
}
function sourceFor(logical) {
  let repository = repositoryRoot, revision = "HEAD", mount = "", inside = "";
  for (const part of logical.split("/")) {
    const candidate = inside === "" ? part : `${inside}/${part}`;
    const entry = treeEntry(repository, revision, candidate);
    if (entry.mode === "160000") {
      const checkout = path.join(repository, candidate);
      git(checkout, ["cat-file", "-e", `${entry.oid}^{commit}`]);
      repository = checkout;
      revision = entry.oid;
      mount = mount === "" ? candidate : `${mount}/${candidate}`;
      inside = "";
    } else {
      inside = candidate;
    }
  }
  return { logical, repository, revision, mount, inside };
}
while (queue.length) {
  const relative = checkedRelative(queue.shift());
  if (seen.has(relative)) continue;
  seen.add(relative);
  const source = sourceFor(relative);
  const packagePath = source.inside === "" ? "package.json" : `${source.inside}/package.json`;
  const manifest = JSON.parse(git(source.repository, ["show", `${source.revision}:${packagePath}`]));
  for (const value of Object.values({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    if (typeof value === "string" && value.startsWith("file:")) queue.push(checkedRelative(path.posix.join(relative, value.slice(5))));
  }
}
for (const relative of [...seen].sort()) {
  const record = sourceFor(relative);
  const proof = { package: record.logical, revision: record.revision, gitlinkMount: record.mount || null, objectPath: record.inside || "." };
  const fields = [record.repository, record.revision, record.mount || ".", record.inside || "."].join("\t");
  process.stdout.write(`${Buffer.from(JSON.stringify(proof)).toString("base64")}\t${Buffer.from(fields).toString("base64")}\n`);
}
NODE
mapfile -t admitted_records < "$records_path"
rm -f "$records_path"

archive_root="$context_dir/lib/emsenn/services/561-group/services/engineering-services-section/services/computer-services-section/services/web-services-section"
proof_path="$context_dir/git-object-closure.jsonl"
: > "$proof_path"
for record in "${admitted_records[@]}"; do
  IFS=$'\t' read -r proof fields <<< "$record"
  printf '%s\n' "$proof" | base64 -d >> "$proof_path"
  printf '\n' >> "$proof_path"
  IFS=$'\t' read -r source_repository source_revision gitlink_mount object_path <<< "$(printf '%s' "$fields" | base64 -d)"
  [[ "$gitlink_mount" == "." ]] && gitlink_mount=""
  [[ "$object_path" == "." ]] && object_path=""
  if [[ -z "$gitlink_mount" ]]; then
    git -C "$source_repository" archive "$source_revision" -- "${object_path:-.}" | tar -C "$archive_root" -xf -
  else
    git -C "$source_repository" archive "$source_revision" -- "${object_path:-.}" \
      | tar -C "$archive_root" --transform="s|^|${gitlink_mount}/|" -xf -
  fi
done
git -C "$repository_root" show "HEAD:${package_relative}/ops/cloud-run/Dockerfile" > "$context_dir/Dockerfile"
git -C "$repository_root" show "HEAD:${package_relative}/ops/cloud-run/cloudbuild.yaml" > "$context_dir/cloudbuild.yaml"
