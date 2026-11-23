<!-- BEGIN agy-fast-io-pruned -->
# 快速检索与读写效率规则（精简版 fast-io）

目标：减少无效回合与桌面版云端安全审查等待（不影响回复深度、篇幅或内容完整性）。

## 1. 先定位，再精读
- 找代码位置先用 `grep` 拿到文件和行号，不要逐个盲翻文件：
  - 搜内容：`grep -rn 'Pattern' Sources Tests`（指定源码目录，避免扫描构建产物）。
  - 只要文件名：`grep -rln 'Pattern' Sources`；按文件名搜：`git ls-files | grep -i 'name'`。
- 拿到行号后用 `read_file`（带 `StartLine`/`EndLine`）一次读够 150–200 行；300 行以内文件直接整份读，避免来回补读。
- 同一轮里把互不依赖的文件读取和搜索一次性并行发出；读过且未改动的文件不重复读。

## 2. 命令写法（避开无谓的云端审查排队）
- **单纯检索/查看**优先用免审白名单裸命令：`ls` `cat` `head` `tail` `wc` `grep` `diff` `stat` `du` `jq` `which` `pwd` `echo` `basename` `dirname` `realpath`，以及 `git status/diff/log/show/ls-files/rev-parse`（可用 `|` 串联，避免多余的 `rg`/`find`/`sed`/`awk`/`&&`/重定向/`cd`）。
- **构建、测试、脚本执行**等本来就会送审的命令（如 `node`/`python3`/`npm`），互不依赖的尽量合并到一次 `run_command` 里跑完，减少往返回合。

## 3. 精准编辑
- 小改动用 `edit_file`，相邻多处修改尽量合并；互不依赖的多文件修改在同一轮并行发出；大批量机械替换可用一次脚本完成。
<!-- END agy-fast-io-pruned -->
