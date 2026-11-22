-- 本地分级上线前，所有 R-18 标记都是手动开的：记成 MANUAL，本地模型以后不再改它们
UPDATE "image" SET "rating_source" = 'MANUAL' WHERE "is_r18" = true AND "rating_source" IS NULL;
