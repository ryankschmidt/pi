// The installer's copy step: one folder or file copied into a new version folder, the same way on macOS and Linux.
// It replaced `cp -cR`, whose -c (APFS clone) GNU cp on the tower and mgr refuses ("cp: invalid option -- 'c'").
// Node's copy clones where the filesystem can (APFS, Btrfs, XFS) and copies otherwise, so a later edit in the source
// never reaches the copy. Links are copied as links with their text unchanged: node_modules links workspace packages
// with relative links, which must keep pointing inside the copy, never back at the fork. Node only, so it runs alone.
import { constants, cpSync } from "node:fs";

/** Copy `source` to `target` (which must not exist), recursively, cloning where possible and keeping links verbatim. */
export function copyTree(source: string, target: string): void {
	cpSync(source, target, {
		recursive: true,
		verbatimSymlinks: true,
		errorOnExist: true,
		force: false,
		mode: constants.COPYFILE_FICLONE,
	});
}
