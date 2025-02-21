// 动态加载侧边栏
function loadSidebar() {
    fetch('../inner_components/sidebar.html')
        .then(response => response.text())
        .then(html => {
            document.getElementById('sidebarContainer').innerHTML = html;
            initSidebarAnimation();
        });
}

// 初始化侧边栏动画效果
function initSidebarAnimation() {
    const sidebarLinks = document.querySelectorAll('#sidebarContainer a');
    sidebarLinks.forEach(link => {
        link.addEventListener('mouseenter', () => {
            link.style.transform = 'translateX(10px)';
        });
        link.addEventListener('mouseleave', () => {
            link.style.transform = 'translateX(0)';
        });
    });
}

// 加载精选文章
function loadFeaturedPosts() {
    fetch('../inner_js/featured_posts.json')
        .then(response => response.json())
        .then(featuredPosts => {
            const postsContainer = document.getElementById('featuredPosts');
            if (postsContainer) {
                postsContainer.innerHTML = '';
                featuredPosts.forEach(post => {
                    const postElement = createPostCard(post);
                    postsContainer.appendChild(postElement);
                });
            }
        });
}

// 创建文章卡片
function createPostCard(post) {
    const article = document.createElement('article');
    article.className = 'post-card animate__animated animate__fadeIn';
    
    article.innerHTML = `
        <a href="${post.url}" class="post-link">
            <div class="post-header">
                <h3 class="post-title">${post.title}</h3>
                <div class="post-meta">
                    <span class="post-date">${post.date}</span>
                </div>
            </div>
            <div class="post-content">
                <p class="post-excerpt">${post.excerpt}</p>
            </div>
        </a>
    `;

    return article;
}

// 初始化菜单切换功能
function initMenuToggle() {
    const menuToggle = document.getElementById('menuToggle');
    const sidebar = document.getElementById('sidebarContainer');

    if (menuToggle && sidebar) {
        menuToggle.addEventListener('click', () => {
            sidebar.classList.toggle('active');
            menuToggle.classList.toggle('active');
        });
    }
}

// 初始化头像点击事件
function initProfileImageClick() {
    const profileImage = document.querySelector('.profile-image');
    if (profileImage) {
        profileImage.style.cursor = 'pointer';
        profileImage.addEventListener('click', function() {
            window.location.href = '../inner_index.html';
        });
    }
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    loadSidebar();
    // 只在存在featuredPosts容器的页面执行加载精选文章
    const postsContainer = document.getElementById('featuredPosts');
    if (postsContainer) {
        loadFeaturedPosts();
    }
    // 初始化菜单切换功能
    initMenuToggle();
    // 初始化头像点击事件
    initProfileImageClick();
});
