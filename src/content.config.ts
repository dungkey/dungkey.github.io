import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
	// 从 `src/content/blog/` 目录加载 Markdown 与 MDX 文件。
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	// 使用 schema 校验 frontmatter
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string(),
			// 将字符串转换为 Date 对象
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date().optional(),
			heroImage: z.optional(image()),
		}),
});

export const collections = { blog };
