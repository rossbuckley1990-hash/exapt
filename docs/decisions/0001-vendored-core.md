# 1. Vendor RightClick X byte-identically

RightClick X is not published to npm. Its package exports point at `dist/` files that a git dependency
would not contain, because they are built with Bun. Node 22's type stripping refuses files under
`node_modules`, so a git dependency could not be imported from source either.

So `vendor/rightclick-x` holds an exact copy of the needed paths at commit `278d66c`, with a SHA-256 for
each file. A test fails if any byte differs, and `npm run upstream:verify` fetches that commit, compares
every file and runs upstream's own tests. Moving to a new upstream means replacing the copy and
regenerating the manifest. Unmerged upstream branches were not incorporated.
