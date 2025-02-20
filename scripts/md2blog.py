import os
import sys
import re
from datetime import datetime
import markdown
from bs4 import BeautifulSoup

def load_component(component_name):
    """加载组件文件内容"""
    component_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'components', f'{component_name}.html')
    with open(component_path, 'r', encoding='utf-8') as f:
        return f.read()

BLOG_TEMPLATE = '''<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="author" content="dungkey" />
    <meta name="description" content="{title}" />
    <title>{title} - dungkey's Blog</title>
    <link rel="stylesheet" href="../css/style.css" />
    <link rel="stylesheet" href="../css/blog.css" />
    <link rel="icon" href="../images/shark.png" />
</head>
<body>
    <button class="menu-toggle" id="menuToggle">
        <span></span>
        <span></span>
        <span></span>
    </button>

    <button class="theme-toggle" id="themeToggle" title="切换主题">
        <svg class="moon" viewBox="0 0 24 24">
            <path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"/>
        </svg>
        <svg class="sun" viewBox="0 0 24 24">
            <path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0-5a1 1 0 0 0 1-1V1a1 1 0 0 0-2 0v1a1 1 0 0 0 1 1zm0 20a1 1 0 0 0-1 1v1a1 1 0 0 0 2 0v-1a1 1 0 0 0-1-1zm13-11h-1a1 1 0 0 0 0 2h1a1 1 0 0 0 0-2zM1 12a1 1 0 0 0-1 1v1a1 1 0 0 0 2 0v-1a1 1 0 0 0-1-1zm20.485-7.071l-1.414 1.414a1 1 0 1 0 1.414 1.414l1.414-1.414a1 1 0 0 0-1.414-1.414zM3.515 19.071l-1.414 1.414a1 1 0 1 0 1.414 1.414l1.414-1.414a1 1 0 0 0-1.414-1.414zM20.485 19.071a1 1 0 0 0-1.414 1.414l1.414 1.414a1 1 0 0 0 1.414-1.414l-1.414-1.414zM3.515 4.929a1 1 0 0 0 1.414-1.414L3.515 2.101A1 1 0 0 0 2.101 3.515l1.414 1.414z"/>
        </svg>
    </button>

    <header>
        <a href="../index.html" class="home-link">
            <img src="../images/shark.png" alt="shark" class="small-logo" />
        </a>
        <h1>{title}</h1>
        <p class="post-meta">发布于 {date}</p>
    </header>

    <div id="sidebarContainer">
    </div>

    <div class="layout-container">
        <main id="mainContent" class="blog-content fixed-content">
            <article>
                {content}
            </article>
        </main>
    </div>

    <footer>
        <p>© 2024 琦珏. All rights reserved.</p>
        <a href="../index.html" class="back-home">返回主页</a>
    </footer>

    <script>
        // 加载侧边栏组件
        fetch('../components/sidebar.html')
            .then(response => response.text())
            .then(html => {{
                document.getElementById('sidebarContainer').innerHTML = html;
                // 在加载完侧边栏后初始化菜单切换功能
                initMenuToggle();
            }});

        function initMenuToggle() {{
            const menuToggle = document.getElementById('menuToggle');
            const sidebar = document.getElementById('sidebar');
            const layoutContainer = document.querySelector('.layout-container');

            if (menuToggle && sidebar && layoutContainer) {{
                menuToggle.addEventListener('click', () => {{
                    sidebar.classList.toggle('active');
                    layoutContainer.classList.toggle('shifted');
                    menuToggle.classList.toggle('active');
                }});
            }}
        }}

        // 主题切换功能
        const themeToggle = document.getElementById('themeToggle');
        const html = document.documentElement;

        // 从localStorage获取主题设置
        const savedTheme = localStorage.getItem('theme') || 'light';
        html.setAttribute('data-theme', savedTheme);

        themeToggle.addEventListener('click', () => {{
            const currentTheme = html.getAttribute('data-theme');
            const newTheme = currentTheme === 'light' ? 'dark' : 'light';
            
            html.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
            
            // 添加动画效果
            themeToggle.style.transform = 'rotate(360deg)';
            setTimeout(() => {{
                themeToggle.style.transform = 'rotate(0)';
            }}, 300);
        }});
    </script>
</body>
</html>'''

def get_title_from_md(md_content):
    """从Markdown内容中提取标题"""
    lines = md_content.split('\n')
    for line in lines:
        if line.startswith('# '):
            return line.replace('# ', '').strip()
    return "无标题博客"

def get_blog_number_from_md(md_path):
    """从Markdown文件名获取博客编号"""
    match = re.search(r'blog(\d+)\.md$', md_path)
    if match:
        return int(match.group(1))
    return None

def get_next_blog_number():
    """获取下一个可用的博客编号"""
    blog_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'blogs')
    if not os.path.exists(blog_dir):
        os.makedirs(blog_dir)
    
    existing_blogs = [f for f in os.listdir(blog_dir) if f.startswith('blog') and f.endswith('.html')]
    if not existing_blogs:
        return 1
    
    numbers = [int(re.search(r'blog(\d+)', blog).group(1)) for blog in existing_blogs]
    return max(numbers) + 1

def get_blog_info_from_file(file_path):
    """从HTML文件中获取博客信息"""
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    soup = BeautifulSoup(content, 'html.parser')
    title = soup.find('h1').text.strip()
    date = soup.find('p', class_='post-meta').text.replace('发布于 ', '').strip()
    return {'title': title, 'date': date, 'file': os.path.basename(file_path)}

def update_blog_list(soup, blog_info, is_blog_page=False):
    """更新博客列表"""
    blog_list = soup.find('ul', id='blogList')
    if not blog_list:
        # 如果找不到列表，创建新的列表
        blog_list = soup.new_tag('ul', id='blogList')
        blog_container = soup.find('div', class_='blog-list')
        if blog_container:
            blog_container.append(blog_list)
    else:
        # 清空现有列表
        blog_list.clear()
    
    # 添加排序后的博客链接
    for info in blog_info:
        new_li = soup.new_tag('li')
        # 使用根目录相对路径
        href = f'/blogs/{info["file"]}'
        new_a = soup.new_tag('a', href=href)
        new_a.string = f'{info["date"]} {info["title"]}'
        new_li.append(new_a)
        blog_list.append(new_li)

def sync_sidebar():
    """同步侧边栏内容"""
    blog_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'blogs')
    if not os.path.exists(blog_dir):
        return
    
    # 获取所有博客文件的信息
    blog_files = [f for f in os.listdir(blog_dir) if f.startswith('blog') and f.endswith('.html')]
    blog_info = []
    
    for blog_file in blog_files:
        file_path = os.path.join(blog_dir, blog_file)
        info = get_blog_info_from_file(file_path)
        blog_info.append(info)
    
    # 按日期排序（最新的在前面）
    blog_info.sort(key=lambda x: datetime.strptime(x['date'], '%Y年%m月%d日'), reverse=True)
    
    # 创建两个不同版本的侧边栏
    sidebar_template = '''<aside id="sidebar">
    <div class="blog-list">
        <h3>我的博客</h3>
        <ul id="blogList">
        </ul>
    </div>
</aside>'''
    
    # 博客页面版本
    blog_soup = BeautifulSoup(sidebar_template, 'html.parser')
    update_blog_list(blog_soup, blog_info, is_blog_page=True)
    
    # 主页版本
    index_soup = BeautifulSoup(sidebar_template, 'html.parser')
    update_blog_list(index_soup, blog_info, is_blog_page=False)
    
    # 保存博客页面版本到组件文件
    component_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'components', 'sidebar.html')
    with open(component_path, 'w', encoding='utf-8') as f:
        f.write(str(blog_soup.prettify()))
    
    # 更新index.html
    index_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'index.html')
    with open(index_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    index_page_soup = BeautifulSoup(content, 'html.parser')
    blog_container = index_page_soup.find('div', id='sidebarContainer')
    if blog_container:
        blog_container.clear()
        blog_container.append(index_soup.find('aside'))
    
    with open(index_path, 'w', encoding='utf-8') as f:
        f.write(str(index_page_soup.prettify()))

def convert_md_links_to_html(content):
    """将Markdown文件中的.md链接转换为.html链接"""
    # 使用正则表达式匹配Markdown链接格式
    pattern = r'\[([^\]]+)\]\(([^\)]+\.md)\)'
    
    def replace_link(match):
        text = match.group(1)
        link = match.group(2)
        # 将.md后缀替换为.html
        html_link = link.replace('.md', '.html')
        # 生成HTML格式的链接
        return f'<a href="{html_link}">{text}</a>'
    
    # 替换所有匹配的链接
    return re.sub(pattern, replace_link, content)

def convert_md_to_html(md_path):
    """将Markdown文件转换为HTML博客"""
    with open(md_path, 'r', encoding='utf-8') as f:
        md_content = f.read()
    
    # 获取标题和内容
    title = get_title_from_md(md_content)
    # 使用更多扩展来处理嵌套列表和其他Markdown特性
    html_content = markdown.markdown(md_content, extensions=['extra', 'sane_lists', 'def_list', 'attr_list', 'md_in_html'])
    
    # 转换HTML中的链接，包括带有锚点的链接
    html_content = re.sub(r'href="([^"]+)\.md(#[^"]+)?"', r'href="\1.html\2"', html_content)
    
    # 获取当前日期
    current_date = datetime.now().strftime('%Y年%m月%d日')
    
    # 获取博客编号
    blog_number = get_blog_number_from_md(md_path)
    if blog_number is None:
        blog_number = get_next_blog_number()
    
    # 加载侧边栏组件
    sidebar = load_component('sidebar')
    
    # 生成HTML
    html = BLOG_TEMPLATE.format(
        title=title,
        date=current_date,
        content=html_content,
        sidebar=sidebar
    )
    
    # 保存HTML文件
    blog_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'blogs')
    if not os.path.exists(blog_dir):
        os.makedirs(blog_dir)
    
    output_path = os.path.join(blog_dir, f'blog{blog_number}.html')
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(html)
    
    # 同步侧边栏
    sync_sidebar()
    
    print(f'成功将 {md_path} 转换为 blog{blog_number}.html')
    print(f'标题: {title}')
    print('已更新侧边栏目录')

if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('使用方法: python md2blog.py <markdown文件路径>')
        sys.exit(1)
    
    md_path = sys.argv[1]
    if not os.path.exists(md_path):
        print(f'错误: 文件 {md_path} 不存在')
        sys.exit(1)
    
    convert_md_to_html(md_path)