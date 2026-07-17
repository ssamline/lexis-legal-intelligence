// Research 리포트의 .gallery 안 이미지(또는 단독 <img>)에 PhotoSwipe 라이트박스를
// 자동으로 붙인다. 갤러리 단위로 그룹화 — 같은 .gallery 안에서만 좌우 스와이프 순환.
//
// 모바일: 핀치 줌, 좌우 스와이프, 끌어서 닫기 (Apple Photos 스타일)
// 데스크톱: 좌우 화살표, 키보드 ←/→/ESC

import PhotoSwipeLightbox from '/research/vendor/photoswipe/photoswipe-lightbox.esm.min.js';

const PSWP_MODULE = () => import('/research/vendor/photoswipe/photoswipe.esm.min.js');

function ensureNaturalSize(img) {
  if (img.complete && img.naturalWidth > 0) return Promise.resolve();
  return new Promise(resolve => {
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', resolve, { once: true });
  });
}

function wrapImagesAsLinks(images) {
  return Array.from(images).map(img => {
    img.style.cursor = 'zoom-in';

    // 이미 a 로 감싸져 있으면 재사용
    if (img.parentNode.tagName === 'A' && img.parentNode.dataset.pswpManaged === '1') {
      return img.parentNode;
    }

    // data-large 가 지정돼 있으면 라이트박스에서 그 이미지를 사용 (선명한 확대)
    const a = document.createElement('a');
    a.href = img.dataset.large || img.src;
    a.target = '_blank';
    a.rel = 'noopener';
    a.dataset.pswpManaged = '1';
    img.parentNode.insertBefore(a, img);
    a.appendChild(img);
    return a;
  });
}

async function setupGallery(container, galleryIdx, scope) {
  const images = container.querySelectorAll('img');
  if (images.length === 0) return;

  const links = wrapImagesAsLinks(images);

  // 자연 사이즈 측정 (PhotoSwipe 가 layout 계산에 필요)
  await Promise.all(Array.from(images).map(ensureNaturalSize));
  Array.from(images).forEach((img, idx) => {
    const a = links[idx];
    a.dataset.pswpWidth = img.naturalWidth || 1280;
    a.dataset.pswpHeight = img.naturalHeight || 720;
  });

  // 갤러리에 식별자 부여
  const galleryId = `pswp-gallery-${scope}-${galleryIdx}`;
  container.id = container.id || galleryId;

  const lightbox = new PhotoSwipeLightbox({
    gallery: `#${container.id}`,
    children: 'a[data-pswp-managed="1"]',
    pswpModule: PSWP_MODULE,
    bgOpacity: 0.92,
    showHideAnimationType: 'zoom',
  });
  lightbox.init();
}

function init() {
  // 1) .gallery 단위 — 같은 갤러리 안에서만 스와이프 순환
  const galleries = document.querySelectorAll('.gallery');
  galleries.forEach((gallery, idx) => setupGallery(gallery, idx, 'g'));

  // 2) 갤러리 밖 단독 <img> — 각각 독립 라이트박스
  // (article 본문의 단독 이미지를 가정. nav·아이콘 등은 alt 가 없거나 작아서 보통 건너뛰지만,
  //  최소한 main content 안에 한정한다.)
  const standalones = Array.from(document.querySelectorAll('body img')).filter(img => {
    if (img.closest('.gallery')) return false;
    if (img.closest('a')) return false;
    if (img.closest('.nav, nav, header, footer')) return false;
    if ((img.naturalWidth || img.width) < 80) return false;  // 아이콘 제외
    return true;
  });
  standalones.forEach((img, idx) => {
    // 임시 컨테이너 — 단일 이미지 라이트박스
    const wrap = document.createElement('span');
    wrap.style.display = 'contents';
    img.parentNode.insertBefore(wrap, img);
    wrap.appendChild(img);
    setupGallery(wrap, idx, 's');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
