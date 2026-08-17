// ---------------------------------------------------------
// 1. Translation Manager (Handles JSON fetching & DOM updates)
// ---------------------------------------------------------
class TranslationManager {
    constructor() {
        this.currentLang = localStorage.getItem('selectedLang') || 'en';
        this.cache = {};
        this.flatTranslations = {};
    }

    // Flattens nested JSON for easy key mapping
    flattenObject(ob) {
        let toReturn = {};
        for (let i in ob) {
            if (!ob.hasOwnProperty(i)) continue;
            if (typeof ob[i] === 'object' && ob[i] !== null && !Array.isArray(ob[i])) {
                let flatObject = this.flattenObject(ob[i]);
                for (let x in flatObject) {
                    if (!flatObject.hasOwnProperty(x)) continue;
                    toReturn[x] = flatObject[x];
                }
            } else {
                toReturn[i] = ob[i];
            }
        }
        return toReturn;
    }

    async changeLanguage(lang) {
        this.currentLang = lang;
        localStorage.setItem('selectedLang', lang);

        if (!this.cache[lang]) {
            try {
                const response = await fetch(`locales/${lang}.json`);
                if (!response.ok) throw new Error('Translation file not found');
                this.cache[lang] = await response.json();
            } catch (error) {
                console.error('Error loading language:', error);
                if (lang !== 'en') this.changeLanguage('en'); // Fallback
                return;
            }
        }

        this.flatTranslations = this.flattenObject(this.cache[lang]);
        this.applyTranslations(this.cache[lang]);

        // RTL Support
        document.body.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');

        // Close menus after selection
        if (window.uiManager) window.uiManager.closeAllMenus();
    }

    applyTranslations(data) {
        // A. Standard data-key text replacement
        document.querySelectorAll("[data-key]").forEach(el => {
            const key = el.getAttribute("data-key");
            if (this.flatTranslations[key]) {
                if (el.tagName === "INPUT") el.placeholder = this.flatTranslations[key];
                else if (el.tagName === "SPAN") el.textContent = this.flatTranslations[key];
                else el.innerHTML = this.flatTranslations[key];
            }
        });

        // B. Index Page Complex Content
        if (document.querySelector('.main-wrapper')) {
            const updateHTML = (sel, content) => {
                const el = document.querySelector(sel);
                if (el && content) el.innerHTML = content;
            };

            updateHTML('.feature-box:nth-child(1) .blog-content', data.index?.f1Content);
            updateHTML('.feature-box:nth-child(2) .blog-content', data.index?.f2Content);
            updateHTML('.feature-box:nth-child(3) .blog-content', data.index?.f3Content);

            document.querySelectorAll('.expandable-box').forEach(box => {
                const btnText = box.querySelector('.more-details-text');
                if (btnText) {
                    btnText.innerText = box.classList.contains('active')
                        ? (this.flatTranslations['showLess'] || "Show Less")
                        : (this.flatTranslations['moreDetails'] || "More Details");
                }
            });

            const howToContainer = document.querySelector('.how-to-section');
            if (howToContainer && data.index?.howToContent) {
                const isExpanded = document.getElementById('howToHiddenContent')?.classList.contains('expanded');
                howToContainer.innerHTML = `
                    <h2 class="section-title">${data.index.howToSectionTitle}</h2>
                    <div class="how-to-content">
                        ${data.index.howToContent}
                        <div class="how-to-hidden-content ${isExpanded ? 'expanded' : ''}" id="howToHiddenContent">
                            ${data.index.howToHiddenContent}
                        </div>
                        <button class="read-more-btn ${isExpanded ? 'expanded' : ''}" id="readMoreHowTo">
                            ${isExpanded ? (data.index.readLessBtn + ' <i class="fas fa-chevron-up"></i>') : (data.index.readMoreBtn + ' <i class="fas fa-chevron-down"></i>')}
                        </button>
                    </div>`;
                window.uiManager.bindHowToBtn(data.index);
            }

            const faqContainer = document.querySelector('.faq-section');
            if (faqContainer && data.index?.faqs) {
                let faqHTML = `<h2 class="section-title">${data.index.faqTitle}</h2><div class="accordion">`;
                data.index.faqs.forEach(faq => {
                    faqHTML += `
                        <div class="accordion-item">
                            <div class="accordion-header">
                                <span>${faq.q}</span><i class="fas fa-plus"></i>
                            </div>
                            <div class="accordion-body">${faq.a}</div>
                        </div>`;
                });
                faqContainer.innerHTML = faqHTML + `</div>`;
                window.uiManager.bindAccordions();
            }

            updateHTML('.seo-article-wrapper', data.index?.seoArticle);
        }

        // C. Standalone Pages
        const articleContainer = document.querySelector('.article-container');
        if (articleContainer) {
            const path = window.location.pathname;
            if (path.includes('about.html')) articleContainer.innerHTML = data.about?.content || '';
            else if (path.includes('privacy.html')) articleContainer.innerHTML = data.privacy?.content || '';
            else if (path.includes('terms.html')) articleContainer.innerHTML = data.terms?.content || '';
        }

        // D. Notifications
        if (data.notifications) {
            document.querySelectorAll('.notif-header h4').forEach(el => el.innerHTML = data.notifications.header);
            document.querySelectorAll('.notif-header .badge').forEach(el => el.innerHTML = data.notifications.newBadge);
            document.querySelectorAll('.notif-info').forEach(info => {
                const h5 = info.querySelector('h5'), p = info.querySelector('.notif-time');
                if (h5) h5.innerHTML = data.notifications.extTitle;
                if (p) p.innerHTML = data.notifications.time;
            });
            document.querySelectorAll('.notif-content').forEach(content => {
                content.innerHTML = `<p>${data.notifications.content1}</p><p>${data.notifications.content2}</p><p>${data.notifications.content3}</p>`;
            });
        }

        // E. SEO Meta Tags
        if (data.seo) {
            const path = window.location.pathname;
            let seo = data.seo;
            let title, desc, kw;

            if (path.includes('about.html')) { title = seo.aboutTitle; desc = seo.aboutDesc; kw = seo.aboutKeywords; }
            else if (path.includes('privacy.html')) { title = seo.privacyTitle; desc = seo.privacyDesc; kw = seo.privacyKeywords; }
            else if (path.includes('terms.html')) { title = seo.termsTitle; desc = seo.termsDesc; kw = seo.termsKeywords; }
            else { title = seo.indexTitle; desc = seo.indexDesc; kw = seo.indexKeywords; }

            document.title = title;
            document.querySelector('meta[name="description"]')?.setAttribute("content", desc);
            document.querySelector('meta[name="keywords"]')?.setAttribute("content", kw);
        }
    }

    getFlatTrans(key, fallback) {
        return this.flatTranslations[key] || fallback;
    }
}

// ---------------------------------------------------------
// 2. UI Manager (Handles interactions, menus, accordions)
// ---------------------------------------------------------
class UIManager {
    init() {
        this.bindMenus();
        this.bindNotifications();
        this.bindExpandableBoxes();
        this.enforceNewTabLinks();
        this.bindAccordions();
        this.bindBrandOrbit();
    }

    bindBrandOrbit() {
        const orbit = document.getElementById('brandOrbit');
        const centerBtn = document.getElementById('orbitCenterBtn');
        if (orbit && centerBtn) {
            centerBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                orbit.classList.toggle('active');
            });

            document.addEventListener('click', (e) => {
                if (!orbit.contains(e.target)) {
                    orbit.classList.remove('active');
                }
            });
        }
    }

    closeAllMenus() {
        document.getElementById('desktopLangMenu')?.classList.remove('active');
        document.getElementById('mobileLangMenu')?.classList.remove('active');
        document.getElementById('sidebar')?.classList.remove('active');
        document.getElementById('desktopNotifPanel')?.classList.remove('active');
        document.getElementById('mobileNotifPanel')?.classList.remove('active');
    }

    bindMenus() {
        const toggleMenu = (btnId, menuId, excludePanelId) => {
            const btn = document.getElementById(btnId);
            const menu = document.getElementById(menuId);
            if (btn && menu) {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    menu.classList.toggle('active');
                    if (excludePanelId) document.getElementById(excludePanelId)?.classList.remove('active');
                });
            }
        };

        toggleMenu('desktopLangToggle', 'desktopLangMenu', 'desktopNotifPanel');
        toggleMenu('mobileLangToggle', 'mobileLangMenu');

        document.getElementById('menuIcon')?.addEventListener('click', () => document.getElementById('sidebar')?.classList.add('active'));
        document.getElementById('closeBtn')?.addEventListener('click', () => document.getElementById('sidebar')?.classList.remove('active'));

        document.addEventListener('click', (e) => {
            const closeIfOutside = (btnId, panelId) => {
                const btn = document.getElementById(btnId), panel = document.getElementById(panelId);
                if (btn && panel && !btn.contains(e.target) && !panel.contains(e.target)) {
                    panel.classList.remove('active');
                }
            };
            closeIfOutside('desktopLangToggle', 'desktopLangMenu');
            closeIfOutside('desktopNotifToggle', 'desktopNotifPanel');
            closeIfOutside('mobileNotifToggle', 'mobileNotifPanel');
        });
    }

    bindNotifications() {
        const setup = (toggleId, panelId) => {
            const toggle = document.getElementById(toggleId), panel = document.getElementById(panelId);
            if (toggle && panel) {
                toggle.addEventListener('click', (e) => {
                    e.preventDefault();
                    panel.classList.toggle('active');
                    const dot = toggle.querySelector('.notif-dot');
                    if (dot) dot.style.display = 'none';
                    if (toggleId === 'desktopNotifToggle') document.getElementById('desktopLangMenu')?.classList.remove('active');
                });
            }
        };

        setup('desktopNotifToggle', 'desktopNotifPanel');
        setup('mobileNotifToggle', 'mobileNotifPanel');

        document.querySelectorAll('.expandable-notif').forEach(notif => {
            notif.addEventListener('click', function () { this.classList.toggle('active'); });
            notif.querySelector('.notif-content')?.addEventListener('click', e => e.stopPropagation());
        });
    }

    bindExpandableBoxes() {
        document.querySelectorAll('.expandable-box').forEach(box => {
            box.addEventListener('click', function () {
                const isActive = this.classList.contains('active');
                const transMgr = window.translationManager;

                document.querySelectorAll('.expandable-box').forEach(b => {
                    b.classList.remove('active');
                    const btnText = b.querySelector('.more-details-text');
                    const icon = b.querySelector('.more-details-btn i');
                    if (btnText) btnText.innerText = transMgr.getFlatTrans('moreDetails', "More Details");
                    if (icon) { icon.classList.remove('fa-chevron-up'); icon.classList.add('fa-chevron-down'); }
                });

                const container = document.getElementById('featuresContainer');
                if (!isActive) {
                    this.classList.add('active');
                    if (container) container.classList.add('has-active-box');

                    const btnText = this.querySelector('.more-details-text');
                    const icon = this.querySelector('.more-details-btn i');
                    if (btnText) btnText.innerText = transMgr.getFlatTrans('showLess', "Show Less");
                    if (icon) { icon.classList.remove('fa-chevron-down'); icon.classList.add('fa-chevron-up'); }
                } else {
                    if (container) container.classList.remove('has-active-box');
                }
            });
            box.querySelector('.blog-content')?.addEventListener('click', e => e.stopPropagation());
        });
    }

    bindAccordions() {
        document.querySelectorAll('.accordion-header').forEach(header => {
            const newHeader = header.cloneNode(true);
            header.parentNode.replaceChild(newHeader, header);

            newHeader.addEventListener('click', () => {
                const item = newHeader.parentElement;
                document.querySelectorAll('.accordion-item').forEach(other => {
                    if (other !== item) other.classList.remove('active');
                });
                item.classList.toggle('active');
            });
        });
    }

    bindHowToBtn(indexData) {
        const btn = document.getElementById('readMoreHowTo');
        const content = document.getElementById('howToHiddenContent');
        if (btn && content) {
            btn.addEventListener('click', () => {
                content.classList.toggle('expanded');
                btn.classList.toggle('expanded');
                btn.innerHTML = content.classList.contains('expanded')
                    ? `${indexData.readLessBtn} <i class="fas fa-chevron-up"></i>`
                    : `${indexData.readMoreBtn} <i class="fas fa-chevron-down"></i>`;
            });
        }
    }

    enforceNewTabLinks() {
        document.querySelectorAll('.footer-btn').forEach(link => {
            const href = link.getAttribute('href');
            if (href && !href.includes('mailto:')) {
                link.removeAttribute('target');
                link.removeAttribute('rel');
            }
        });
    }
}

// ---------------------------------------------------------
// 3. Download Manager (Handles API Fetching & Results UI)
// ---------------------------------------------------------
class DownloadManager {
    constructor() {
        this.baseUrl = "https://video-downloader-pxhf.onrender.com";
        this.btn = document.getElementById('downloadBtn');
        this.input = document.getElementById('videoUrl');
        this.status = document.getElementById('statusMessage');
        this.card = document.getElementById('resultCard');
        this.videoPreview = document.getElementById('videoPreview');
        this.imagePreview = document.getElementById('imagePreview');

        this.historyKey = 'fb_video_history';
        this.createSuggestionBox();
    }

    init() {
        if (this.btn && this.input) {
            this.btn.addEventListener('click', () => this.processDownload());
            this.bindHistoryEvents();
        }
    }

    createSuggestionBox() {
        this.suggestionBox = document.createElement('div');
        this.suggestionBox.className = 'suggestion-box';

        const inputGroup = document.querySelector('.input-group');
        if (inputGroup) {
            inputGroup.style.position = 'relative';
            inputGroup.appendChild(this.suggestionBox);
        }
    }

    bindHistoryEvents() {
        this.input.addEventListener('focus', () => this.showSuggestions());
        this.input.addEventListener('click', () => this.showSuggestions());

        document.addEventListener('click', (e) => {
            if (!this.input.contains(e.target) && !this.suggestionBox.contains(e.target)) {
                this.hideSuggestions();
            }
        });

        window.addEventListener('resize', () => {
            if (this.suggestionBox.classList.contains('active')) {
                this.positionSuggestionBox();
            }
        });
    }

    showSuggestions() {
        let history = JSON.parse(localStorage.getItem(this.historyKey) || '[]');
        if (history.length === 0) {
            this.hideSuggestions();
            return;
        }

        this.suggestionBox.innerHTML = '';
        history.forEach(url => {
            const item = document.createElement('div');
            item.className = 'suggestion-item';
            
            const icon = document.createElement('i');
            icon.className = 'fas fa-history';
            
            const textSpan = document.createElement('span');
            textSpan.textContent = url;
            
            item.appendChild(icon);
            item.appendChild(textSpan);
            
            item.addEventListener('click', () => {
                this.input.value = url;
                this.hideSuggestions();
            });
            this.suggestionBox.appendChild(item);
        });

        this.suggestionBox.classList.add('active');
        this.positionSuggestionBox();
    }

    positionSuggestionBox() {
        if (!this.input || !this.suggestionBox) return;
        this.suggestionBox.style.top = `${this.input.offsetTop + this.input.offsetHeight + 5}px`;
        this.suggestionBox.style.left = `${this.input.offsetLeft}px`;
        this.suggestionBox.style.width = `${this.input.offsetWidth}px`;
    }

    hideSuggestions() {
        if (this.suggestionBox) {
            this.suggestionBox.classList.remove('active');
        }
    }

    saveToHistory(url) {
        let history = JSON.parse(localStorage.getItem(this.historyKey) || '[]');
        history = history.filter(item => item !== url);
        history.unshift(url);
        if (history.length > 3) history = history.slice(0, 3);
        localStorage.setItem(this.historyKey, JSON.stringify(history));
    }

    async processDownload() {
        const url = this.input.value.trim();
        const transMgr = window.translationManager;

        if (!url) {
            alert(transMgr.getFlatTrans('emptyLinkAlert', "Please paste a link first!"));
            return;
        }

        this.saveToHistory(url);
        this.hideSuggestions();
        this.input.value = '';
        this.input.blur();

        const origText = this.btn.innerHTML;
        this.btn.innerHTML = `${transMgr.getFlatTrans('processing', "Processing...")} <i class='fas fa-spinner fa-spin'></i>`;
        this.btn.disabled = true;
        this.resetUI();

        try {
            const res = await fetch(`${this.baseUrl}/api/download?url=${encodeURIComponent(url)}`);

            // Checking if response is actually JSON and not an HTML error page
            const contentType = res.headers.get("content-type");
            if (!contentType || !contentType.includes("application/json")) {
                console.error("Backend crashed and returned HTML instead of JSON.");
                this.onError("Backend server crashed. Please check Render logs.");
                return;
            }

            const data = await res.json();

            if (res.ok && data.success) {
                this.onSuccess(data, transMgr);
            } else {
                this.onError(data.error || "Extraction failed.");
            }

        } catch (err) {
            console.error("Network/Fetch Error:", err);
            // This happens if CORS fails or server is completely down
            this.onError("Connection blocked or Server is down. Check CORS policy.");
        } finally {
            this.btn.innerHTML = origText;
            this.btn.disabled = false;
        }
    }

    resetUI() {
        if (this.card) this.card.style.display = "none";
        if (this.status) this.status.style.display = "none";
        if (this.videoPreview) {
            this.videoPreview.pause();
            this.videoPreview.removeAttribute('src');
        }
    }

    onSuccess(data, transMgr) {
        if (this.card) this.card.style.display = "block";

        const isImg = data.type === "image";
        if (this.videoPreview) this.videoPreview.style.display = isImg ? "none" : "block";
        if (this.imagePreview) this.imagePreview.style.display = isImg ? "block" : "none";

        if (isImg && this.imagePreview) this.imagePreview.src = data.video_high;
        if (!isImg && this.videoPreview) this.videoPreview.src = data.video_normal || data.video_high;

        this.configureDownloadLinks(data, isImg, transMgr);
        this.showStatus(transMgr.getFlatTrans('successMsg', "✅ Ready!"), "#4ade80");
    }

    configureDownloadLinks(data, isImg, transMgr) {
        const setLink = (id, url, type, quality = '') => {
            const el = document.getElementById(id);
            if (el && url) {
                const uniqueId = Math.floor(Date.now() / 1000);
                const prefix = type === 'mp3' ? 'FB_Audio' : (isImg ? 'FB_Image' : 'FB_Video');
                const fileName = `${prefix}_${uniqueId}.${type}`;
                const qParam = quality ? `&q=${quality}` : '';
                el.href = `${this.baseUrl}/api/direct?url=${encodeURIComponent(url)}&type=${type}&t=${uniqueId}${qParam}`;
                el.setAttribute('download', fileName);
            }
        };

        const btnAudHigh = document.getElementById('btnAudHigh');
        const btnAudNorm = document.getElementById('btnAudNorm');
        const btnVidNorm = document.getElementById('btnVidNorm');
        const btnVidHigh = document.getElementById('btnVidHigh');

        if (isImg) {
            [btnAudHigh, btnAudNorm, btnVidNorm].forEach(b => { if (b) b.style.display = "none"; });
            if (btnVidHigh) {
                btnVidHigh.innerHTML = '<i class="fas fa-image"></i> Download Image';
                setLink('btnVidHigh', data.video_high, 'jpg');
            }
        } else {
            [btnAudHigh, btnAudNorm, btnVidNorm].forEach(b => { if (b) b.style.display = "flex"; });
            if (btnVidHigh) {
                btnVidHigh.innerHTML = `<i class="fas fa-video"></i> <span data-key="dlVidHigh">${transMgr.getFlatTrans('dlVidHigh', 'Video (HD)')}</span>`;
            }

            setLink('btnVidHigh', data.video_high, 'mp4', 'hd');
            setLink('btnVidNorm', data.video_normal, 'mp4', 'sd');
            setLink('btnAudHigh', data.audio_high, 'mp3', 'hq');
            setLink('btnAudNorm', data.audio_normal, 'mp3', 'normal');
        }
    }

    onError(msg) {
        this.showStatus(`❌ ${msg}`, "#ff4757");
    }

    showStatus(msg, color) {
        if (this.status) {
            this.status.style.display = "block";
            this.status.style.color = color;
            this.status.innerHTML = msg;
        }
    }
}

// ---------------------------------------------------------
// Theme Manager (Handles 3-Mode Sliding Segmented Themes)
// ---------------------------------------------------------
class ThemeManager {
    constructor() {
        this.currentTheme = localStorage.getItem('siteTheme') || 'dark';
    }

    init() {
        this.applyTheme(this.currentTheme, false);
        this.bindEvents();

        window.addEventListener('resize', () => this.updatePillPositions());
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => this.updatePillPositions());
        }
        setTimeout(() => this.updatePillPositions(), 30);
        setTimeout(() => this.updatePillPositions(), 150);
        setTimeout(() => this.updatePillPositions(), 500);
    }

    applyTheme(theme, animate = true) {
        if (!['premium', 'dark', 'light'].includes(theme)) {
            theme = 'dark';
        }
        this.currentTheme = theme;
        localStorage.setItem('siteTheme', theme);
        document.documentElement.setAttribute('data-theme', theme);
        document.body.setAttribute('data-theme', theme);

        this.updatePillPositions();
    }

    updatePillPositions() {
        document.querySelectorAll('[data-theme-switcher]').forEach(switcher => {
            const pill = switcher.querySelector('.theme-pill');
            const btns = switcher.querySelectorAll('.theme-btn');
            let activeBtn = null;

            btns.forEach((btn) => {
                const btnTheme = btn.getAttribute('data-theme-val');
                if (btnTheme === this.currentTheme) {
                    btn.classList.add('active');
                    activeBtn = btn;
                } else {
                    btn.classList.remove('active');
                }
            });

            if (pill && activeBtn) {
                const left = activeBtn.offsetLeft;
                const top = activeBtn.offsetTop;
                const width = activeBtn.offsetWidth;
                const height = activeBtn.offsetHeight;

                pill.style.width = `${width}px`;
                pill.style.height = `${height}px`;
                pill.style.transform = `translate(${left}px, ${top}px)`;
                pill.style.opacity = '1';
            }
        });
    }

    bindEvents() {
        document.querySelectorAll('[data-theme-switcher] .theme-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const targetTheme = btn.getAttribute('data-theme-val');
                this.applyTheme(targetTheme, true);
            });
        });
    }
}

// ---------------------------------------------------------
// 4. Initialization & Global Expose
// ---------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    window.themeManager = new ThemeManager();
    window.translationManager = new TranslationManager();
    window.uiManager = new UIManager();
    window.downloadManager = new DownloadManager();

    window.themeManager.init();
    window.uiManager.init();
    window.downloadManager.init();

    window.translationManager.changeLanguage(window.translationManager.currentLang);

    window.changeLanguage = (lang) => {
        window.translationManager.changeLanguage(lang);
    };

    window.changeTheme = (theme) => {
        window.themeManager.applyTheme(theme, true);
    };
});
