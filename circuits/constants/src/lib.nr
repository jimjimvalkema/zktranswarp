// @TODO make more accurate statements based on gas instead of tps
// ---------- why max tree depth 42 --------------------
// const erc20Tps = 35_000;
// const zktranswarpTps = erc20Tps / 10;
// const bulkMerkleInserts = 1; // becomes relevant once large reMints emitting multiple commitments are more gas efficient then simple burns. 
// const insertsPerYear = bulkMerkleInserts * zktranswarpTps * 60*60*24*365;
// const treeDepth = 44;
// (2**treeDepth) / insertsPerYear

// depth 44 allows for 100+ years on a 35_000 tps chain (megaEth stress test) if every tx is a burn tx
// after that, any tokens burned will be actually be burned for real and you will never get them back!
// any tokens before that are fine. That leaf will always exist and the contract always stores that root.
// you can burn tokens before the tree is at a depth above 42, and reMint them a 100 years later those will always be there.
// the ui can warn you, but contract cant prevent it because the contract can't know if your address is a burn address or a normal address!
// ----------------------------------------------------------
pub global MAX_TREE_DEPTH: u32 = 44;