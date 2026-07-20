---
title: 'Markdown 样式指南'
description: '在 Astro 中编写 Markdown 内容时，一些基础语法的示例。'
pubDate: 'Jun 19 2024'
heroImage: '../../assets/blog-placeholder-1.jpg'
---

下文展示在 Astro 中编写 Markdown 内容时常用的基础语法示例。

## 标题

下列 HTML `<h1>`—`<h6>` 对应六个层级的章节标题。`<h1>` 最高，`<h6>` 最低。

# H1

## H2

### H3

#### H4

##### H5

###### H6

## 段落

这是第一段示例正文，用来演示普通段落在主题中的行高、字重与外边距。写博客时，段落不宜过长；若一个观点需要较多文字，可以拆成多段或加小标题，让读者更容易扫读与定位重点。

这是第二段示例正文。你可以在这里继续展开论据、举例或补充背景。占位内容没有实际主题，仅用于预览排版效果；发布前请替换为自己的文章。

## 图片

### 语法

```markdown
![替代文本](./full/or/relative/path/of/image)
```

### 效果

![博客占位图](../../assets/blog-placeholder-about.jpg)

## 引用

`blockquote` 表示摘自其他来源的内容；可选地附上出处，且出处应放在 `footer` 或 `cite` 元素内；也可包含行内修改，如注释与缩写。

### 无出处的引用

#### 语法

```markdown
> 这是一段示例引用，用来演示多行块引用。  
> **注意** 引用内仍可使用 _Markdown 语法_。
```

#### 效果

> 这是一段示例引用，用来演示多行块引用。  
> **注意** 引用内仍可使用 _Markdown 语法_。

### 带出处的引用

#### 语法

```markdown
> 不要通过共享内存来通信；要通过通信来共享内存。<br>
> — <cite>Rob Pike[^1]</cite>
```

#### 效果

> 不要通过共享内存来通信；要通过通信来共享内存。<br>
> — <cite>Rob Pike[^1]</cite>

[^1]: 上文引自 Rob Pike 在 2015 年 11 月 18 日 Gopherfest 上的[演讲](https://www.youtube.com/watch?v=PAAkCSZUG1c)。

## 表格

### 语法

```markdown
| 斜体   | 粗体   | 代码   |
| ------ | ------ | ------ |
| _斜体_ | **粗体** | `code` |
```

### 效果

| 斜体   | 粗体   | 代码   |
| ------ | ------ | ------ |
| _斜体_ | **粗体** | `code` |

## 代码块

### 语法

可用三个反引号 ``` 单独占一行开始代码片段，再用一行三个反引号结束。若要高亮某种语言，在开头三个反引号后写一个语言标识，例如 html、javascript、css、markdown、typescript、txt、bash。

````markdown
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>示例 HTML5 文档</title>
  </head>
  <body>
    <p>测试</p>
  </body>
</html>
```
````

### 效果

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>示例 HTML5 文档</title>
  </head>
  <body>
    <p>测试</p>
  </body>
</html>
```

## 列表类型

### 有序列表

#### 语法

```markdown
1. 第一项
2. 第二项
3. 第三项
```

#### 效果

1. 第一项
2. 第二项
3. 第三项

### 无序列表

#### 语法

```markdown
- 列表项
- 另一项
- 还有一项
```

#### 效果

- 列表项
- 另一项
- 还有一项

### 嵌套列表

#### 语法

```markdown
- 水果
  - 苹果
  - 橙子
  - 香蕉
- 乳制品
  - 牛奶
  - 奶酪
```

#### 效果

- 水果
  - 苹果
  - 橙子
  - 香蕉
- 乳制品
  - 牛奶
  - 奶酪

## 其他元素 — abbr、sub、sup、kbd、mark

### 语法

```markdown
<abbr title="Graphics Interchange Format">GIF</abbr> 是一种位图图像格式。

H<sub>2</sub>O

X<sup>n</sup> + Y<sup>n</sup> = Z<sup>n</sup>

按下 <kbd>CTRL</kbd> + <kbd>ALT</kbd> + <kbd>Delete</kbd> 可结束会话。

多数 <mark>蝾螈</mark> 在夜间活动，捕食昆虫、蠕虫和其他小型生物。
```

### 效果

<abbr title="Graphics Interchange Format">GIF</abbr> 是一种位图图像格式。

H<sub>2</sub>O

X<sup>n</sup> + Y<sup>n</sup> = Z<sup>n</sup>

按下 <kbd>CTRL</kbd> + <kbd>ALT</kbd> + <kbd>Delete</kbd> 可结束会话。

多数 <mark>蝾螈</mark> 在夜间活动，捕食昆虫、蠕虫和其他小型生物。
