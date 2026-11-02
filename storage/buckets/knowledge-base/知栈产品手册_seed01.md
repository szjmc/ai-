# 知栈产品手册

知栈负责把业务文档送进知识库。一次入库固定做两件事：把原文件写入对象桶，再在 knowledge_files 登记元数据。

## 入库字段

- collection_name：知识集合，例如「产品知识库」
- file_name：对象桶中的存储名，会附加短随机后缀避免重名
- file_type：文件后缀
- minio_path：对象路径，形如 knowledge-base/文件名
- chunk_strategy：默认 adaptive
- status：上传完成后为 uploaded

## 支持的文件

pdf、doc、docx、xls、xlsx、txt、sql、json、md。其他类型会在写入存储之前被拒绝。

## 状态怎么用

uploaded 表示文件已经落桶并完成登记，还没有纳入检索。核对内容后改为 active。暂时停用标 inactive，需要留痕时标 archived。
