import os
import re
import json
import markdown
from bs4 import BeautifulSoup
from datetime import datetime

def load_template(template_path):
    """加载HTML模板"""
    with open(template_path, 'r', encoding='utf-8') as f:
        return f.read()

def extract_metadata(md_content):
    """从Markdown内容中提取元数据，保留原始格式"""
    metadata = {
        'title': '',
        'date': '',
        'category': '',
        'tags': [],
        'featured': False,
        'excerpt': '',
        'description': ''
    }
    
    lines = md_content.split('\n')
    if lines and lines[0].strip() == '---':
        meta_end = -1
        for i, line in enumerate(lines[1:], 1):
            if line.strip() == '---':
                meta_end = i
                break
        
        if meta_end > 0:
            meta_lines = lines[1:meta_end]
            for line in meta_lines:
                if ':' in line:
                    key, value = [x.strip() for x in line.split(':', 1)]
                    key = key.lower()
                    
                    # 处理带引号的值
                    if value.startswith('"') and value.endswith('"'):
                        value = value[1:-1]
                    
                    if key == 'tags':
                        # 处理标签列表
                        tags = value.strip('[]').split(',')
                        metadata[key] = [tag.strip().strip('"') for tag in tags]
                    elif key == 'featured':
                        metadata[key] = value.lower() == 'true'
                    else:
                        metadata[key] = value
            
            # 如果没有摘要，使用description作为摘要
            if not metadata['excerpt'] and metadata['description']:
                metadata['excerpt'] = metadata['description']
            
            return metadata, '\n'.join(lines[meta_end + 1:])
    
    return metadata, md_content

def convert_md_to_html(md_path, output_dir='inner_blogs'):
    """将Markdown文件转换为HTML"""
    with open(md_path, 'r', encoding='utf-8') as f:
        md_content = f.read()
    
    metadata, content = extract_metadata(md_content)
    
    # 使用文件名作为标题的后备选项
    if not metadata['title']:
        metadata['title'] = os.path.splitext(os.path.basename(md_path))[0]
    
    # 使用当前日期作为后备选项
    if not metadata['date']:
        metadata['date'] = datetime.now().strftime('%Y-%m-%d')
    
    # 转换Markdown为HTML
    html_content = markdown.markdown(
        content,
        extensions=[
            'markdown.extensions.fenced_code',
            'markdown.extensions.tables',
            'markdown.extensions.toc',
            'markdown.extensions.meta'
        ]
    )
    
    template = load_template('inner_components/article_template.html')
    html_output = template.replace('{{title}}', metadata['title'])\
                         .replace('{{date}}', metadata['date'])\
                         .replace('{{content}}', html_content)
    
    os.makedirs(output_dir, exist_ok=True)
    output_filename = os.path.splitext(os.path.basename(md_path))[0] + '.html'
    output_path = os.path.join(output_dir, output_filename)
    
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(html_output)
    
    return metadata

def update_featured_posts(posts_metadata):
    """更新首页的精选文章列表"""
    featured_posts = [post for post in posts_metadata if post.get('featured', False)]
    featured_posts = sorted(featured_posts, key=lambda x: x['date'], reverse=True)
    
    featured_posts_json = []
    for post in featured_posts:
        excerpt = post.get('excerpt', '').strip() or post.get('description', '').strip() or '这是一篇精选文章...'
        
        featured_post = {
            'title': f'"{post["title"]}"',  # 确保标题带引号
            'excerpt': excerpt,
            'date': f'"{post["date"]}"',  # 确保日期带引号
            'url': f'inner_blogs/{os.path.splitext(post["filename"])[0]}.html'
        }
        featured_posts_json.append(featured_post)
    
    # 确保输出目录存在
    os.makedirs('inner_js', exist_ok=True)
    
    # 保存为JSON，保持原有格式
    with open('inner_js/featured_posts.json', 'w', encoding='utf-8') as f:
        json.dump(featured_posts_json, f, ensure_ascii=False, indent=2)

def update_sidebar(posts_metadata):
    """更新侧边栏的文章列表"""
    sorted_posts = sorted(posts_metadata, key=lambda x: x['date'], reverse=True)
    
    posts_html = ''
    for post in sorted_posts:
        posts_html += f'''
        <li>
            <a href="/inner_blogs/{os.path.splitext(post['filename'])[0]}.html">
                <span class="post-title">{post['title']}</span>
                <span class="post-date">{post['date']}</span>
            </a>
        </li>
        '''
    
    sidebar_path = 'inner_components/sidebar.html'
    with open(sidebar_path, 'r', encoding='utf-8') as f:
        sidebar_content = f.read()
    
    soup = BeautifulSoup(sidebar_content, 'html.parser')
    post_list = soup.find('ul', class_='modern-list')
    if post_list:
        post_list.clear()
        post_list.append(BeautifulSoup(posts_html, 'html.parser'))
    
    with open(sidebar_path, 'w', encoding='utf-8') as f:
        f.write(str(soup))

def process_all_markdown_files():
    """处理所有Markdown文件"""
    md_dir = 'inner_markdown'
    posts_metadata = []
    
    for filename in os.listdir(md_dir):
        if filename.endswith('.md'):
            try:
                md_path = os.path.join(md_dir, filename)
                metadata = convert_md_to_html(md_path)
                metadata['filename'] = filename
                posts_metadata.append(metadata)
            except Exception as e:
                print(f'处理文件 {filename} 时出错: {str(e)}')
    
    try:
        update_sidebar(posts_metadata)
        update_featured_posts(posts_metadata)
        print('成功更新所有文件')
    except Exception as e:
        print(f'更新过程中出错: {str(e)}')

if __name__ == '__main__':
    process_all_markdown_files()