// controller.js (최종 수정 버전 - 100ms 스로틀링 적용)

document.addEventListener('DOMContentLoaded', () => {
    // ❗️ (Firebase 초기화 검사 생략)
    if (typeof db === 'undefined') {
        console.error("Firebase Firestore 'db' is not initialized.");
        alert("Firebase 연결 실패! HTML을 확인하세요.");
        return;
    }

    // --- 1. 세션 ID 및 Firebase 레퍼런스 설정 ---
    const urlParams = new URLSearchParams(window.location.search);
    const SESSION_ID = urlParams.get('session');
    
    if (!SESSION_ID) {
        alert("유효한 세션 ID가 없습니다. QR 코드를 다시 스캔하세요.");
        document.body.innerHTML = "<h1>연결 실패</h1><p>유효한 세션 ID가 없습니다. PC의 QR 코드를 다시 스캔하세요.</p>";
        return;
    }

    const CONTROLLER_REF = db.collection('controllers').doc(SESSION_ID);

    // --- DOM 요소 및 변수 (생략) ---
    const mainCanvasFrame = document.querySelector('.main-canvas-frame');
    const touchPadsWrapper = document.querySelector('.touch-pads-wrapper');
    const deleteButton = document.getElementById('delete-selected-deco');
    const controlGroupWrapper = document.querySelector('.control-group-wrapper');
    const sceneInfoEl = document.querySelector('.scene-info');

    let currentDecoList = []; 
    let selectedDecoIds = []; 
    const activeTouches = new Map(); 

    // =========================================================================
    // ⭐ 🚨통신 핵심 로직 (Firebase)🚨 ⭐
    // =========================================================================

    // --- 1. 모바일 -> PC (명령 전송) ---
    async function sendCommandToFirestore(action, data = {}) {
        if (!SESSION_ID) return;

        if (action !== 'item_click' && action !== 'control_one' && selectedDecoIds.length === 0) {
             console.warn("No item selected for action:", action);
             return;
        }
        
        const commandData = {
            ...data,
            ids: (action === 'control_one' || action === 'item_click') ? (data.id ? [data.id] : []) : (data.ids || selectedDecoIds)
        };

        if (action === 'control_one' || action === 'item_click') {
            commandData.id = data.id;
        }

        const command = {
            action: action,
            data: commandData,
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        };
        
        try {
            // [참고] Set 작업은 문서 전체를 덮어쓰므로 1회의 '쓰기'로 계산됩니다.
            await CONTROLLER_REF.set({ command: command }, { merge: true });
        } catch (error) {
            console.error("Error sending command to Firestore:", error);
        }
    }

    // --- 2. PC -> 모바일 (상태 수신) (생략) ---
    function listenForPCState() {
        CONTROLLER_REF.onSnapshot((doc) => {
            if (doc.exists && doc.data().pcState) {
                const state = doc.data().pcState;
                
                sceneInfoEl.textContent = `Scene ${state.scene} 연결됨`;
                currentDecoList = state.decoList || []; 
                selectedDecoIds = state.selectedIds || []; 

                updateTouchPads();
            } else {
                sceneInfoEl.textContent = "PC 연결 대기 중...";
                currentDecoList = [];
                selectedDecoIds = []; 
                updateTouchPads();
            }
        }, (error) => {
            console.error("Error listening for PC state:", error);
            sceneInfoEl.textContent = "연결 오류!";
        });
    }

    // =========================================================================
    // ⭐ DOM Reconciliation & 달라붙음 방지 로직 ⭐
    // =========================================================================
    function updateTouchPads() {
        if (mainCanvasFrame.offsetWidth === 0) return; 

        const frameWidth = mainCanvasFrame.offsetWidth;
        const frameHeight = mainCanvasFrame.offsetHeight;
        
        const draggingIds = new Set(Array.from(activeTouches.values()).map(data => data.decoId));
        
        const existingPads = new Map();
        touchPadsWrapper.querySelectorAll('.touch-pad').forEach(pad => {
            existingPings.set(pad.dataset.id, pad);
        });

        // --- 1. currentDecoList (새 상태)를 기준으로 DOM 업데이트 및 추가 ---
        currentDecoList.forEach((deco, index) => {
            let pad = existingPads.get(deco.id);

            const mobileNormY = deco.y_mobile; 
            const mobileNormX = 1.0 - deco.x_mobile; // PC와 모바일 좌표계 역전
            const pixelX = mobileNormX * frameWidth;
            const pixelY = mobileNormY * frameHeight;

            if (pad) {
                existingPads.delete(deco.id); 

                // 🚨 드래그 중인 아이템이 아니라면, PC의 좌표로 업데이트합니다.
                if (!draggingIds.has(deco.id)) {
                    pad.style.left = `${pixelX}px`;
                    pad.style.top = `${pixelY}px`;
                }
                
                pad.classList.toggle('selected', selectedDecoIds.includes(deco.id));

            } else {
                // 1b. 새 패드 생성 (로직 생략)
                pad = document.createElement('button');
                pad.classList.add('touch-pad');
                pad.id = `touch-pad-${deco.id}`;
                pad.dataset.id = deco.id;
                pad.title = `아이템 ${index + 1} 선택 및 이동`;

                pad.style.left = `${pixelX}px`;
                pad.style.top = `${pixelY}px`;
                
                if (selectedDecoIds.includes(deco.id)) {
                    pad.classList.add('selected');
                }

                touchPadsWrapper.appendChild(pad);
                setTimeout(() => { pad.style.opacity = '1'; }, 10); 
            }
        });

        // --- 2. 맵에 남아있는 패드 (stale) DOM에서 삭제 (생략) ---
        existingPads.forEach(pad => {
            pad.style.opacity = '0';
            setTimeout(() => { pad.remove(); }, 300);
        });

        // --- 3. 버튼 활성화/비활성화 (생략) ---
        updateButtonDisabledState();

    } // --- updateTouchPads 끝 ---
    
    function updateButtonDisabledState() {
        const isSelected = selectedDecoIds.length > 0;
        document.querySelectorAll('.control-btn').forEach(btn => {
            btn.disabled = !isSelected;
        });
        deleteButton.disabled = !isSelected;
        controlGroupWrapper.classList.toggle('active', isSelected);
    }


    // =========================================================================
    // ⭐ 멀티터치 이벤트 핸들러 (움직임 핵심 로직) ⭐
    // =========================================================================
    
    // 'touchstart' (생략)
    touchPadsWrapper.addEventListener('touchstart', (e) => {
        const frameRect = mainCanvasFrame.getBoundingClientRect();
        const frameWidth = frameRect.width;
        const frameHeight = frameRect.height;

        for (const touch of e.changedTouches) {
            const targetPad = touch.target.closest('.touch-pad');
            
            if (targetPad) { 
                const decoId = targetPad.dataset.id;
                
                activeTouches.set(touch.identifier, {
                    pad: targetPad,
                    decoId: decoId,
                    lastX: touch.clientX,
                    lastY: touch.clientY,
                    frameWidth: frameWidth,
                    frameHeight: frameHeight,
                    isDragging: false, 
                    isThrottled: false, 
                    finalNormX: -1, 
                    finalNormY: -1 
                });

                if (selectedDecoIds.includes(decoId)) {
                    targetPad.classList.add('active'); 
                }
            }
        }
    }, { passive: false }); 

    // 'touchmove' 
    touchPadsWrapper.addEventListener('touchmove', (e) => {
        if (activeTouches.size > 0) {
              e.preventDefault(); 
        }

        for (const touch of e.changedTouches) {
            const dragData = activeTouches.get(touch.identifier);

            if (dragData && dragData.pad && selectedDecoIds.includes(dragData.decoId)) {
                
                dragData.isDragging = true; 

                const { pad, lastX, lastY, frameWidth, frameHeight } = dragData;
                const dx = touch.clientX - lastX;
                const dy = touch.clientY - lastY;
                let currentPadLeft = parseFloat(pad.style.left);
                let currentPadTop = parseFloat(pad.style.top);
                let newPadLeft = currentPadLeft + dx;
                let newPadTop = currentPadTop + dy;
                
                // 경계 제한 로직은 제거된 상태 유지

                // 1. 로컬 UI 즉시 업데이트
                pad.style.left = `${newPadLeft}px`;
                pad.style.top = `${newPadTop}px`;
                dragData.lastX = touch.clientX;
                dragData.lastY = touch.clientY;

                // 2. PC로 보낼 좌표 계산 (정규화 및 좌표계 역전)
                const mobileNormX = newPadLeft / frameWidth;
                const mobileNormY = newPadTop / frameHeight;
                const logic_Site_TB = 1.0 - mobileNormX; // PC의 Y좌표
                const logic_Site_LR = mobileNormY;     // PC의 X좌표

                // 3. 'touchend'에서 사용할 최종 좌표 저장
                dragData.finalNormX = logic_Site_TB;
                dragData.finalNormY = logic_Site_LR;

                // 4. 100ms 스로틀링 (할당량 초과 방지)
                if (dragData.isThrottled) {
                    continue; 
                }
                dragData.isThrottled = true;
                setTimeout(() => {
                    if (activeTouches.has(touch.identifier)) {
                        activeTouches.get(touch.identifier).isThrottled = false;
                    }
                }, 100); // ⭐️ [핵심 수정] 100ms로 증가 ⭐️

                // 5. PC로 'control_one' (move) 명령 전송
                sendCommandToFirestore('control_one', { 
                    id: dragData.decoId, 
                    action: 'move',
                    x_mobile: logic_Site_TB, 
                    y_mobile: logic_Site_LR 
                });
            }
        }
    }, { passive: false }); 

    // 'touchend' (생략)
    const touchEndOrCancel = (e) => {
        for (const touch of e.changedTouches) {
            const dragData = activeTouches.get(touch.identifier);

            if(dragData) {
                dragData.pad.classList.remove('active'); 

                if (dragData.isDragging === true) {
                    // 최종 위치 1회 전송 (누락 방지)
                    if (dragData.finalNormX !== -1) {
                         sendCommandToFirestore('control_one', { 
                             id: dragData.decoId, 
                             action: 'move',
                             x_mobile: dragData.finalNormX, 
                             y_mobile: dragData.finalNormY 
                         });
                    }

                } else {
                    // [탭] 드래그되지 않았으므로 'item_click' 전송
                    sendCommandToFirestore('item_click', { id: dragData.decoId });
                }
            }
            activeTouches.delete(touch.identifier);
        }
    };

    touchPadsWrapper.addEventListener('touchend', touchEndOrCancel);
    touchPadsWrapper.addEventListener('touchcancel', touchEndOrCancel);


    // --- 6. 버튼 이벤트 리스너 (생략) ---
    document.querySelectorAll('.control-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (selectedDecoIds.length === 0 || btn.disabled) return;
            const action = btn.dataset.action;
            const direction = btn.dataset.direction;
            
            sendCommandToFirestore('control_multi', { 
                action: action, 
                direction: direction 
            });
        });
    });

    // --- 7. 삭제 버튼 (생략) ---
    deleteButton.addEventListener('click', () => {
        if (selectedDecoIds.length === 0 || deleteButton.disabled) return;
        sendCommandToFirestore('delete_multi');
    });
    
    // --- 8. 초기화 ---
    listenForPCState();

    // 리사이즈 이벤트
    window.addEventListener('resize', () => {
        updateTouchPads();
    });
});