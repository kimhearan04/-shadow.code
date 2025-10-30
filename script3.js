// script3.js (Supabase 최종 수정 버전 - PC 측)

document.addEventListener('DOMContentLoaded', () => {
    // ⭐ Supabase 클라이언트 초기화 확인 (HTML에서 초기화되었다고 가정) ⭐
    if (typeof supabase === 'undefined') {
        console.error("Supabase client is not initialized. Please ensure the Supabase SDK is loaded and initialized in your HTML.");
        alert("Supabase 연결 실패! HTML을 확인하세요.");
        return;
    }

    const TABLE_NAME = 'controllers'; 

    // --- 1. 모드 판별, 기본 변수 및 세션 설정 ---
    let SESSION_ID = new URLSearchParams(window.location.search).get('session');
    if (!SESSION_ID) {
        // 세션 ID가 없으면 생성하고 URL을 업데이트 (PC 모드일 경우)
        SESSION_ID = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        window.history.replaceState({}, document.title, `?session=${SESSION_ID}`);
    }
    
    // --- DOM 요소 및 데이터 ---
    const canvas = document.getElementById('canvas');
    const openControllerBtn = document.getElementById('open-controller-btn');
    const verticalGuide = document.querySelector('.vertical-guide');
    const horizontalGuide = document.querySelector('.horizontal-guide');
    const qrModal = document.getElementById('qr-modal');
    const qrcodeDiv = document.getElementById('qrcode-container');
    const storyData = {
        '1': { background: '', decorations: [] }, '2': { background: '', decorations: [] },
        '3': { background: '', decorations: [] }, '4': { background: '', decorations: [] },
        '5': { background: '', decorations: [] }, '6': { background: '', decorations: [] },
        '7': { background: '', decorations: [] }, '8': { background: '', decorations: [] }
    };
    let currentScene = '1';
    let selectedDecoIds = []; 
    let toastTimer = null;

    // --- 알림창 표시 함수 ---
    function showLimitToast() {
        const toast = document.getElementById('limit-toast-notification');
        if (toastTimer) clearTimeout(toastTimer);
        toast.style.display = 'flex'; 
        toastTimer = setTimeout(() => {
            toast.style.display = 'none';
            toastTimer = null;
        }, 3000);
    }

    // =========================================================================
    // ⭐ 🚨통신 핵심 로직 (Supabase)🚨 ⭐
    // =========================================================================

    // PC -> 모바일 (상태 동기화)
    async function syncStateToSupabase() { // 함수명 변경
        if (!canvas || canvas.offsetWidth === 0 || canvas.offsetHeight === 0) return;

        const canvasWidth = canvas.offsetWidth;
        const canvasHeight = canvas.offsetHeight;

        const decoListForMobile = storyData[currentScene].decorations.map(deco => {
            const decoWidth = deco.width;
            const decoHeight = deco.height;
            // 중앙 좌표를 기준으로 정규화합니다.
            const centerX = deco.x + decoWidth / 2;
            const centerY = deco.y + decoHeight / 2;

            return {
                id: deco.id,
                // x_mobile (모바일 세로) = PC의 Y축 정규화 값 
                x_mobile: centerY / canvasHeight, 
                // y_mobile (모바일 가로) = PC의 X축 정규화 값 
                y_mobile: centerX / canvasWidth    
            };
        });
        
        const state = {
            scene: currentScene,
            selectedIds: selectedDecoIds, 
            decoList: decoListForMobile,
            timestamp: new Date().toISOString() // ⭐ [Supabase] JS 날짜 사용 ⭐
        };

        try {
            // ⭐ [Supabase 전환] Row 업데이트: pcState 필드 업데이트 ⭐
            const { error } = await supabase
                .from(TABLE_NAME)
                .update({ pcState: state })
                .eq('id', SESSION_ID);
            
            // 만약 해당 ID의 row가 없다면 (처음 연결 시), insert 시도
            if (error && error.code === 'PGRST116') { // 로우가 없다는 Supabase의 일반적인 에러 코드를 가정합니다.
                 const { error: insertError } = await supabase
                    .from(TABLE_NAME)
                    .insert([{ id: SESSION_ID, pcState: state, command: null }]);
                if (insertError) throw insertError;
            } else if (error) {
                throw error;
            }

        } catch (error) {
            console.error("Error syncing state to Supabase:", error.message);
        }
    }
    
    // 모바일 -> PC (조작 명령 수신 리스너)
    let lastCommandTimestamp = 0;
    function listenForControlCommands() {
        // ⭐ [Supabase 전환] Realtime Listener 사용 ⭐
        supabase
            .channel(`controller_commands_${SESSION_ID}`) // 고유 채널 이름 사용
            .on(
                'postgres_changes',
                { 
                    event: 'UPDATE', 
                    schema: 'public', 
                    table: TABLE_NAME,
                    filter: `id=eq.${SESSION_ID}` // 해당 세션 ID의 row만 필터링
                },
                (payload) => {
                    const command = payload.new.command; // 업데이트된 row의 command 필드 접근
                    
                    if (command) {
                        // Supabase의 timestamp는 문자열이므로 파싱
                        const currentTimestamp = new Date(command.timestamp).getTime(); 
                        
                        // Firebase의 toMillis() 대신 JS의 getTime()을 사용
                        if (currentTimestamp > lastCommandTimestamp) {
                            lastCommandTimestamp = currentTimestamp;
                            const action = command.action;
                            const data = command.data || {};

                            if (action === 'item_click') {
                                handleItemClick(data.id); 
                            } else if (action === 'control_one') {
                                // 역변환: x_mobile -> PC의 Y좌표, y_mobile -> PC의 X좌표
                                handleItemMove(data.id, data.x_mobile, data.y_mobile); 
                            } else if (action === 'control_multi') {
                                data.ids.forEach(id => {
                                    handleControllerControl(id, data.action, { direction: data.direction });
                                });
                            } else if (action === 'delete_multi') {
                                data.ids.forEach(id => {
                                    handleControllerControl(id, 'delete');
                                });
                            }

                            // ⭐ [Supabase 전환] 명령 처리 후 필드 NULL로 업데이트 (명령 소비) ⭐
                            supabase
                                .from(TABLE_NAME)
                                .update({ command: null })
                                .eq('id', SESSION_ID)
                                .then(({ error }) => {
                                    if (error) console.error("Error clearing command field:", error.message);
                                });
                        }
                    }
                }
            )
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    console.log("Supabase Realtime Subscribed.");
                } else if (status === 'CHANNEL_ERROR') {
                    console.error("Supabase Channel Error!");
                }
            });
    }

    // =========================================================================
    // ⭐ PC 메인 웹사이트 모드 로직 ⭐
    // =========================================================================
    
    listenForControlCommands(); 
    
    if (openControllerBtn) {
        openControllerBtn.addEventListener('click', () => {
            if (qrModal) qrModal.style.display = 'flex';
            
            // ⭐ [파일명 규칙 준수] 모바일 컨트롤러 HTML 경로를 controller.html로 설정 ⭐
            const baseUrl = window.location.href.substring(0, window.location.href.lastIndexOf('/'));
            const controllerUrl = `${baseUrl}/controller.html?session=${SESSION_ID}`; 
            
            if (qrcodeDiv) qrcodeDiv.innerHTML = '';
            if (qrcodeDiv && typeof QRCode !== 'undefined') {
                new QRCode(qrcodeDiv, { text: controllerUrl, width: 256, height: 256 });
            }
            syncStateToSupabase(); 
        });
    }

    // --- 컨트롤러 클릭 처리 함수 ---
    function handleItemClick(id) {
        if (!id) return;
        const isSelected = selectedDecoIds.includes(id);

        if (isSelected) {
            selectedDecoIds = selectedDecoIds.filter(i => i !== id);
        } else {
            if (selectedDecoIds.length < 2) {
                selectedDecoIds.push(id);
            } else {
                selectedDecoIds.shift();
                selectedDecoIds.push(id);
            }
        }
        selectItems(selectedDecoIds, 'pc'); 
    }


    // --- 아이템 선택 처리 함수 ---
    function selectItems(ids = [], source = 'pc') {
        selectedDecoIds = ids;
        document.querySelectorAll('.decoration-item').forEach(el => {
            el.classList.toggle('selected', selectedDecoIds.includes(el.id));
        });
        
        // 선택/해제는 항상 즉시 동기화
        syncStateToSupabase(); 
    }

    // --- 모바일 좌표계로 아이템 이동 처리 (경계 제한 포함) ---
    function handleItemMove(id, mobileControllerY, mobileControllerX) {
        if (!canvas || !id) return;
        const decoData = storyData[currentScene].decorations.find(d => d.id === id);
        const element = document.getElementById(id);
        if (!decoData || !element) return;

        const canvasWidth = canvas.offsetWidth;
        const canvasHeight = canvas.offsetHeight;
        
        // 좌표 역변환 (모바일 좌표 -> PC 픽셀 좌표)
        // mobileControllerX (모바일 가로 0~1) -> PC의 X축 픽셀
        // mobileControllerY (모바일 세로 0~1) -> PC의 Y축 픽셀
        let centerX = mobileControllerX * canvasWidth;
        let centerY = mobileControllerY * canvasHeight;

        let newX = centerX - (decoData.width / 2);
        let newY = centerY - (decoData.height / 2);

        // 🌟 PC에서 캔버스 경계를 넘지 않도록 강제 적용 (튕김 방지)
        newX = Math.max(0, Math.min(newX, canvasWidth - decoData.width));
        newY = Math.max(0, Math.min(newY, canvasHeight - decoData.height));
        
        decoData.x = newX;
        decoData.y = newY;
        
        // PC UI는 즉시 업데이트
        updateElementStyle(decoData);
        updateThumbnail(currentScene); 
        
        // 이동 명령에 대한 동기화는 제거됨 (롤백 방지 최적화)
        // syncStateToSupabase(); 
    }

    // --- 컨트롤러 버튼 조작 처리 함수 ---
    function handleControllerControl(id, action, data) {
        let decoData = storyData[currentScene].decorations.find(d => d.id === id);
        if (!decoData) return;

        const step = { rotate: 5, scale: 0.02 }; 
        
        if (action === 'rotate' || action === 'scale' || action === 'flip') {
            if (action === 'rotate') {
                const direction = data.direction;
                if (direction === 'LEFT') { decoData.rotation -= step.rotate; }
                else if (direction === 'RIGHT') { decoData.rotation += step.rotate; }
            } else if (action === 'scale') {
                const direction = data.direction;
                const factor = 1 + (direction === 'UP' ? step.scale : -step.scale);
                const currentWidth = decoData.width;
                const currentHeight = decoData.height;
                if (currentWidth * factor > 20 && currentHeight * factor > 20) {
                    const deltaWidth = (currentWidth * factor) - currentWidth;
                    const deltaHeight = (currentHeight * factor) - currentHeight;
                    decoData.width *= factor;
                    decoData.height *= factor;
                    decoData.x -= deltaWidth / 2;
                    decoData.y -= deltaHeight / 2;
                }
            } else if (action === 'flip') {
                decoData.scaleX *= -1;
            }
            
            updateElementStyle(decoData);
            updateThumbnail(currentScene);
            
            // 회전/크기/반전은 즉시 동기화
            syncStateToSupabase(); 

        } else if (action === 'delete') {
            const index = storyData[currentScene].decorations.findIndex(d => d.id === id);
            if (index > -1) {
                storyData[currentScene].decorations.splice(index, 1);
                const element = document.getElementById(id);
                if (element) element.remove();
                
                // 삭제는 즉시 동기화
                if (selectedDecoIds.includes(id)) {
                    selectedDecoIds = selectedDecoIds.filter(i => i !== id);
                    selectItems(selectedDecoIds, 'pc'); 
                } else {
                    syncStateToSupabase();
                }
                updateThumbnail(currentScene);
                return; 
            }
        }
    }

    // --- (이하 나머지 코드들은 이전과 동일합니다) ---

    function updateElementStyle(decoData) {
        const element = document.getElementById(decoData.id);
        if (!element) return;
        element.style.left = decoData.x + 'px';
        element.style.top = decoData.y + 'px';
        element.style.width = decoData.width + 'px';
        element.style.height = decoData.height + 'px';
        element.style.transform = `rotate(${decoData.rotation}deg)`;
        const img = element.querySelector('img');
        if (img) {
            img.style.transform = `scaleX(${decoData.scaleX})`;
        }
    }

    document.querySelectorAll('.asset-item[data-type="decoration"]').forEach(item => {
        item.addEventListener('click', () => {
            if (storyData[currentScene].decorations.length >= 3) {
                showLimitToast(); 
                return;
            }
            const canvasImageSrc = item.dataset.canvasSrc || item.src; 
            let initialWidth = 200; 
            let initialHeight = 200;
            if (canvasImageSrc.includes('나비.png')) { 
                initialWidth = 150; 
                initialHeight = 150; 
            }
            const newDeco = {
                id: 'deco-' + Date.now(), src: canvasImageSrc,
                width: initialWidth, height: initialHeight,
                x: (canvas.offsetWidth / 2) - (initialWidth / 2),
                y: (canvas.offsetHeight / 2) - (initialHeight / 2),
                rotation: 0, scaleX: 1,
            };
            storyData[currentScene].decorations.push(newDeco);
            renderScene(currentScene);
            selectItems([newDeco.id], 'pc'); 
        });
    });

    function renderScene(sceneNumber) {
        if (!canvas) return;
        const data = storyData[sceneNumber];
        
        Array.from(canvas.children).forEach(child => {
            if (child.classList.contains('decoration-item')) {
                child.remove();
            }
        });
        
        data.decorations.forEach(createDecorationElement);
        
        const newDecoIds = new Set(data.decorations.map(d => d.id));
        selectedDecoIds = selectedDecoIds.filter(id => newDecoIds.has(id));
        
        selectItems(selectedDecoIds, 'pc'); 
        
        setTimeout(() => updateThumbnail(sceneNumber), 50);
    }

    function createDecorationElement(decoData) {
            if (!canvas) return;
        const item = document.createElement('div');
        item.className = 'decoration-item';
        item.id = decoData.id;
        item.style.left = decoData.x + 'px';
        item.style.top = decoData.y + 'px';
        item.style.width = decoData.width + 'px';
        item.style.height = decoData.height + 'px';
        item.style.transform = `rotate(${decoData.rotation}deg)`;
        
        const img = document.createElement('img');
        img.src = decoData.src;
        img.onerror = function() { 
            img.src = `https://placehold.co/${Math.round(decoData.width)}x${Math.round(decoData.height)}/eee/ccc?text=이미지+로드+실패`;
        };
        img.style.transform = `scaleX(${decoData.scaleX})`;

        const controls = document.createElement('div');
        controls.className = 'controls';
        controls.innerHTML = `<button class="flip" title="좌우반전"><img src="img/좌우반전.png" alt="좌우반전" onerror="this.parentNode.innerHTML='반전'"></button>
                                     <button class="delete" title="삭제"><img src="img/휴지통.png" alt="삭제" onerror="this.parentNode.innerHTML='삭제'"></button>`;
        
        const handles = ['tl', 'tr', 'bl', 'br', 'rotator'].map(type => {
            const handle = document.createElement('div');
            handle.className = `handle ${type}`;
            return handle;
        });

        item.append(img, ...handles, controls);
        canvas.appendChild(item);
        makeInteractive(item);
    }

    function makeInteractive(element) {
        const decoData = storyData[currentScene].decorations.find(d => d.id === element.id);
        if (!decoData) return;

        element.addEventListener('mousedown', (e) => {
            if (e.target.closest('.handle') || e.target.closest('.controls')) return;
            handleItemClick(element.id);
            e.stopPropagation();
        });

        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        element.onmousedown = function(e) {
            if (e.target.closest('.handle') || e.target.closest('.controls')) return;
            
            if (!selectedDecoIds.includes(element.id)) {
                 handleItemClick(element.id);
            }
            
            e.preventDefault();
            pos3 = e.clientX;
            pos4 = e.clientY;
            document.onmouseup = closeDragElement;
            document.onmousemove = elementDrag;
        };

        function elementDrag(e) {
            if (verticalGuide) verticalGuide.style.display = 'none';
            if (horizontalGuide) horizontalGuide.style.display = 'none';
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            let newTop = element.offsetTop - pos2;
            let newLeft = element.offsetLeft - pos1;
            
            const snapThreshold = 5; 
            if (!canvas) return;
            const canvasWidth = canvas.offsetWidth;
            const canvasHeight = canvas.offsetHeight;
            const elementWidth = element.offsetWidth;
            const elementHeight = element.offsetHeight;
            const canvasCenterX = canvasWidth / 2;
            const canvasCenterY = canvasHeight / 2;
            const elementCenterX = newLeft + elementWidth / 2;
            const elementCenterY = newTop + elementHeight / 2;
            let snappedX = false;
            let snappedY = false;
            if (Math.abs(elementCenterX - canvasCenterX) < snapThreshold) {
                newLeft = canvasCenterX - elementWidth / 2;
                if (verticalGuide) {
                    verticalGuide.style.left = `${canvasCenterX}px`;
                    verticalGuide.style.display = 'block';
                }
                snappedX = true;
            }
            if (Math.abs(elementCenterY - canvasCenterY) < snapThreshold) {
                newTop = canvasCenterY - elementHeight / 2;
                if (horizontalGuide) {
                    horizontalGuide.style.top = `${canvasCenterY}px`;
                    horizontalGuide.style.display = 'block';
                }
                snappedY = true;
            }
            if (!snappedX && verticalGuide) verticalGuide.style.display = 'none';
            if (!snappedY && horizontalGuide) horizontalGuide.style.display = 'none';
            
            // 경계 제한을 적용합니다. (마우스 드래그 시 PC에서도 벗어나지 않도록)
            newLeft = Math.max(0, Math.min(newLeft, canvasWidth - elementWidth));
            newTop = Math.max(0, Math.min(newTop, canvasHeight - elementHeight));

            element.style.top = newTop + "px";
            element.style.left = newLeft + "px";
        }
        
        function closeDragElement() {
            document.onmouseup = null;
            document.onmousemove = null;
            if (verticalGuide) verticalGuide.style.display = 'none';
            if (horizontalGuide) horizontalGuide.style.display = 'none';
            
            decoData.x = element.offsetLeft;
            decoData.y = element.offsetTop;
            
            updateThumbnail(currentScene); 
            syncStateToSupabase(); // 함수명 변경
        }
        
        element.querySelectorAll('.handle:not(.rotator)').forEach(handle => {
            handle.onmousedown = initResize;
        });
        
        function initResize(e) {
            e.preventDefault(); e.stopPropagation();
            const handleType = e.target.classList[1];
            const rect = element.getBoundingClientRect();
            const angleRad = decoData.rotation * (Math.PI / 180);
            const aspectRatio = decoData.width / decoData.height; 
            const corners = getRotatedCorners(rect, angleRad);
            const oppositeCornerMap = { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' };
            const pivot = corners[oppositeCornerMap[handleType]]; 
            const isLeft = handleType.includes('l');
            const isTop = handleType.includes('t');
            document.onmousemove = (e_move) => {
                const mouseVector = { x: e_move.clientX - pivot.x, y: e_move.clientY - pivot.y };
                const rotatedMouseVector = {
                    x: mouseVector.x * Math.cos(-angleRad) - mouseVector.y * Math.sin(-angleRad),
                    y: mouseVector.x * Math.sin(-angleRad) + mouseVector.y * Math.cos(-angleRad)
                };
                let newWidth, newHeight;
                if (Math.abs(rotatedMouseVector.x) / aspectRatio > Math.abs(rotatedMouseVector.y)) {
                    newWidth = Math.abs(rotatedMouseVector.x);
                    newHeight = newWidth / aspectRatio;
                } else {
                    newHeight = Math.abs(rotatedMouseVector.y);
                    newWidth = newHeight * aspectRatio;
                }
                if (newWidth < 20) return; 
                const signX = isLeft ? -1 : 1;
                const signY = isTop ? -1 : 1;
                const localCenter = { x: (signX * newWidth) / 2, y: (signY * newHeight) / 2 };
                const rotatedCenterVector = {
                    x: localCenter.x * Math.cos(angleRad) - localCenter.y * Math.sin(angleRad),
                    y: localCenter.x * Math.sin(angleRad) + localCenter.y * Math.cos(angleRad)
                };
                const newGlobalCenter = { x: pivot.x + rotatedCenterVector.x, y: pivot.y + rotatedCenterVector.y };
                if (!canvas) return;
                const canvasRect = canvas.getBoundingClientRect();
                const finalLeft = newGlobalCenter.x - (newWidth / 2) - canvasRect.left;
                const finalTop = newGlobalCenter.y - (newHeight / 2) - canvasRect.top;
                element.style.width = newWidth + 'px';
                element.style.height = newHeight + 'px';
                element.style.left = finalLeft + 'px';
                element.style.top = finalTop + 'px';
            };
            document.onmouseup = () => {
                document.onmousemove = null; document.onmouseup = null;
                decoData.width = parseFloat(element.style.width);
                decoData.height = parseFloat(element.style.height);
                decoData.x = element.offsetLeft;
                decoData.y = element.offsetTop;
                updateThumbnail(currentScene); 
                syncStateToSupabase(); // 함수명 변경
            };
        }
        
        const rotator = element.querySelector('.rotator');
        if (rotator) {
            rotator.onmousedown = function(e) {
                e.preventDefault(); e.stopPropagation();
                const rect = element.getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;
                const startAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX) * (180 / Math.PI);
                let startRotation = decoData.rotation;
                document.onmousemove = function(e_move) {
                    const currentAngle = Math.atan2(e_move.clientY - centerY, e.clientX - centerX) * (180 / Math.PI);
                    let newRotation = startRotation + (currentAngle - startAngle);
                    const snapThreshold = 6;
                    const snappedAngle = Math.round(newRotation / 90) * 90;
                    if (Math.abs(newRotation - snappedAngle) < snapThreshold) {
                        newRotation = snappedAngle;
                    }
                    element.style.transform = `rotate(${newRotation}deg)`;
                    decoData.rotation = newRotation;
                };
                document.onmouseup = function() {
                    document.onmousemove = null; document.onmouseup = null;
                    updateThumbnail(currentScene);
                    syncStateToSupabase(); // 함수명 변경
                };
            };
        }

        const flipButton = element.querySelector('.flip');
        if (flipButton) {
            flipButton.addEventListener('click', (e) => {
                e.stopPropagation();
                decoData.scaleX *= -1;
                updateElementStyle(decoData);
                syncStateToSupabase(); // 함수명 변경
                updateThumbnail(currentScene);
            });
        }
        const deleteButton = element.querySelector('.delete');
        if (deleteButton) {
            deleteButton.addEventListener('click', (e) => {
                e.stopPropagation();
                handleControllerControl(element.id, 'delete');
            });
        }
    } 
    
    function getRotatedCorners(rect, angle) {
        const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        const corners = {
            tl: { x: rect.left, y: rect.top }, tr: { x: rect.right, y: rect.top },
            bl: { x: rect.left, y: rect.bottom }, br: { x: rect.right, y: rect.bottom }
        };
        for (const key in corners) {
            corners[key] = rotatePoint(corners[key], center, angle);
        }
        return corners;
    }
    function rotatePoint(point, center, angle) {
        const dx = point.x - center.x;
        const dy = point.y - center.y;
        const newX = center.x + dx * Math.cos(angle) - dy * Math.sin(angle);
        const newY = center.y + dx * Math.sin(angle) + dy * Math.cos(angle);
        return { x: newX, y: newY };
    }

    document.addEventListener('mousedown', (e) => {
        if (!e.target.closest('.decoration-item') && !e.target.closest('.asset-item') && !e.target.closest('#qr-modal')) {
            selectItems([], 'pc');
        }
    });

    const scenes = document.querySelectorAll('.scene');
    scenes.forEach(scene => {
        scene.addEventListener('click', () => {
            scenes.forEach(s => s.classList.remove('active'));
            scene.classList.add('active');
            currentScene = scene.dataset.scene;
            renderScene(currentScene); 
        });
    });
    
    function updateThumbnail(sceneNumber) {
        const sceneEl = document.querySelector(`.scene[data-scene="${sceneNumber}"]`);
        if (sceneEl) {
            sceneEl.innerHTML = ''; 
            const sceneData = storyData[sceneNumber];
            sceneEl.style.backgroundImage = 'none';
            if(!canvas || canvas.offsetWidth === 0) return;
            const scaleX = sceneEl.offsetWidth / canvas.offsetWidth;
            const scaleY = sceneEl.offsetHeight / canvas.offsetHeight;
            sceneData.decorations.forEach(decoData => {
                const miniDeco = document.createElement('div');
                miniDeco.style.position = 'absolute';
                miniDeco.style.width = (decoData.width * scaleX) + 'px';
                miniDeco.style.height = (decoData.height * scaleY) + 'px';
                miniDeco.style.left = (decoData.x * scaleX) + 'px';
                miniDeco.style.top = (decoData.y * scaleY) + 'px';
                miniDeco.style.backgroundImage = `url(${decoData.src})`;
                miniDeco.style.backgroundSize = 'contain';
                miniDeco.style.backgroundRepeat = 'no-repeat';
                miniDeco.style.backgroundPosition = 'center';
                miniDeco.style.transform = `rotate(${decoData.rotation}deg) scaleX(${decoData.scaleX})`;
                sceneEl.appendChild(miniDeco);
            });
        }
    }

    // 초기 렌더링
    renderScene(currentScene);
});
