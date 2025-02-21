// 常量配置
const CONFIG = {
    ANIMATION_DURATION: 300,
    SIDEBAR_SLIDE_DISTANCE: '10px',
    ERROR_MESSAGES: {
        SIDEBAR_LOAD: '无法加载侧边栏内容',
        POSTS_LOAD: '无法加载精选文章'
    }
};

// 工具函数
const utils = {
    /**
     * 防抖函数
     * @param {Function} fn 要执行的函数
     * @param {number} delay 延迟时间
     */
    debounce(fn, delay) {
        let timer = null;
        return function (...args) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
    },

    /**
     * 安全的HTML转义
     * @param {string} str 要转义的字符串
     */
    escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
};

// 动态加载侧边栏
async function loadSidebar() {
    try {
        const response = await fetch('../inner_components/sidebar.html');
        if (!response.ok) throw new Error(CONFIG.ERROR_MESSAGES.SIDEBAR_LOAD);

        const html = await response.text();
        const sidebarContainer = document.getElementById('sidebarContainer');
        if (sidebarContainer) {
            sidebarContainer.innerHTML = html;
            initSidebarAnimation();
        }
    } catch (error) {
        console.error('加载侧边栏失败:', error);
    }
}

// 初始化侧边栏动画效果
function initSidebarAnimation() {
    const sidebarLinks = document.querySelectorAll('#sidebarContainer a');
    const handleMouseEnter = utils.debounce((event) => {
        event.target.style.transform = `translateX(${CONFIG.SIDEBAR_SLIDE_DISTANCE})`;
    }, 50);

    const handleMouseLeave = utils.debounce((event) => {
        event.target.style.transform = 'translateX(0)';
    }, 50);

    sidebarLinks.forEach(link => {
        link.addEventListener('mouseenter', handleMouseEnter);
        link.addEventListener('mouseleave', handleMouseLeave);
    });
}

// 加载精选文章
async function loadFeaturedPosts() {
    try {
        const response = await fetch('../inner_js/featured_posts.json');
        if (!response.ok) throw new Error(CONFIG.ERROR_MESSAGES.POSTS_LOAD);

        const data = await response.json();
        const postsContainer = document.getElementById('featuredPosts');

        if (postsContainer) {
            const fragment = document.createDocumentFragment();
            data.posts.forEach(post => {
                const postElement = createPostCard(post);
                fragment.appendChild(postElement);
            });
            postsContainer.innerHTML = '';
            postsContainer.appendChild(fragment);

            // 添加渐入动画
            const cards = postsContainer.querySelectorAll('.post-card');
            cards.forEach((card, index) => {
                card.style.animationDelay = `${index * 0.1}s`;
            });
        }
    } catch (error) {
        console.error('加载精选文章失败:', error);

        // 显示错误提示
        const postsContainer = document.getElementById('featuredPosts');
        if (postsContainer) {
            postsContainer.innerHTML = `
                <div class="error-message" role="alert">
                    <p>😢 加载文章失败，请稍后再试</p>
                </div>
            `;
        }
    }
}

// 创建文章卡片
function createPostCard(post) {
    const article = document.createElement('article');
    article.className = 'post-card animate__animated animate__fadeIn';
    article.setAttribute('role', 'article');

    // 使用HTML转义防止XSS攻击
    const safePost = {
        url: utils.escapeHTML(post.url),
        title: utils.escapeHTML(post.title),
        date: utils.escapeHTML(post.date),
        excerpt: utils.escapeHTML(post.excerpt),
        readingTime: post.readingTime || '5分钟',
        category: utils.escapeHTML(post.category || '未分类')
    };

    article.innerHTML = `
        <a href="${safePost.url}" class="post-link" aria-label="${safePost.title}">
            <div class="post-header">
                <h3 class="post-title">${safePost.title}</h3>
                <div class="post-meta">
                    <span class="post-date">${safePost.date}</span>
                    <span class="post-category">📑 ${safePost.category}</span>
                    <span class="post-reading-time">⏱️ ${safePost.readingTime}</span>
                </div>
            </div>
            <div class="post-content">
                <p class="post-excerpt">${safePost.excerpt}</p>
            </div>
        </a>
    `;

    // 添加键盘导航支持
    const link = article.querySelector('.post-link');
    link.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            window.location.href = safePost.url;
        }
    });

    return article;
}

// 初始化菜单切换功能
function initMenuToggle() {
    const menuToggle = document.getElementById('menuToggle');
    const sidebar = document.getElementById('sidebarContainer');

    if (menuToggle && sidebar) {
        const toggleMenu = utils.debounce(() => {
            sidebar.classList.toggle('active');
            menuToggle.classList.toggle('active');

            // 更新ARIA状态
            const isExpanded = sidebar.classList.contains('active');
            menuToggle.setAttribute('aria-expanded', isExpanded);
        }, 100);

        menuToggle.addEventListener('click', toggleMenu);

        // 添加键盘支持
        menuToggle.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggleMenu();
            }
        });
    }
}

// 初始化头像点击事件
function initProfileImageClick() {
    const profileImage = document.querySelector('.profile-image');
    if (profileImage) {
        profileImage.style.cursor = 'pointer';
        profileImage.addEventListener('click', () => {
            window.location.href = '../inner_index.html';
        });

        // 添加键盘支持
        profileImage.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                window.location.href = '../inner_index.html';
            }
        });

        // 添加可访问性支持
        profileImage.setAttribute('role', 'link');
        profileImage.setAttribute('tabindex', '0');
        profileImage.setAttribute('aria-label', '返回首页');
    }
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    // 使用 Promise.all 并行加载资源
    Promise.all([
        loadSidebar(),
        document.getElementById('featuredPosts') ? loadFeaturedPosts() : Promise.resolve()
    ]).catch(error => console.error('初始化失败:', error));

    initMenuToggle();
    initProfileImageClick();
});

