// controller.js (Supabase 최종 수정 버전 - 모바일 컨트롤러 측)

document.addEventListener('DOMContentLoaded', () => {
    // ⭐ Supabase 클라이언트 확인 ⭐
    if (typeof supabase === 'undefined') {
        console.error("Supabase client is not initialized.");
        document.getElementById('loading-screen').innerHTML = '<h2>연결 오류: Supabase SDK를 확인하세요.</h2>';
        return;
    }

    const TABLE_NAME = 'controllers'; 
    const urlParams = new URLSearchParams(window.location.search);
    const SESSION_ID = urlParams.get('session');
    
    if (!SESSION_ID) {
        document.getElementById('loading-screen').innerHTML = '<h2>세션 ID가 없습니다. PC에서 QR코드를 다시 스캔해주세요.</h2>';
        return;
    }

    // --- DOM 요소 ---
    const loadingScreen = document.getElementById('loading-screen');
    const mainController = document.getElementById('main-controller');
    const sceneIndicator = document.getElementById('scene-indicator');
    const connectionStatus = document.getElementById('connection-status');
    const selectedListDiv = document.getElementById('selected-list');
    const joystickControl = document.getElementById('joystick-control');
    const joystickCenter = document.getElementById('joystick-center');
    const controlButtons = document.querySelectorAll('.control-btn');
    const toast = document.getElementById('selection-limit-toast');

    // --- 상태 변수 ---
    let pcState = {}; // PC에서 받은 최신 상태 저장
    let selectedDecoIds = [];
    let isDragging = false;
    let joystickRect = null;
    let joystickCenterRect = null;
    let lastMoveCommand = 0;
    const THROTTLE_TIME_MOVE = 1000 / 30; // 30 FPS로 제한

    // --- 알림창 표시 함수 ---
    function showLimitToast() {
        toast.style.opacity = '1';
        setTimeout(() => {
            toast.style.opacity = '0';
        }, 3000);
    }
    
    // =========================================================================
    // ⭐ 🚨통신 핵심 로직 (Supabase)🚨 ⭐
    // =========================================================================

    /**
     * 모바일 -> PC로 명령 전송
     * @param {string} action 실행할 명령 (예: 'item_click', 'control_one', 'rotate', 'delete')
     * @param {object} data 명령과 함께 보낼 데이터
     */
    async function sendCommandToPC(action, data = {}) {
        const command = {
            action: action,
            data: data,
            timestamp: new Date().toISOString() // Supabase를 위한 서버리스 타임스탬프
        };

        try {
            // ⭐ [Supabase 전환] Row 업데이트: command 필드 업데이트 ⭐
            // PC측 리스너는 이 필드의 변화를 감지하고 명령을 처리한 후, 이 필드를 다시 NULL로 지웁니다.
            const { error } = await supabase
                .from(TABLE_NAME)
                .update({ command: command })
                .eq('id', SESSION_ID);

            if (error) throw error;

        } catch (error) {
            console.error("Error sending command to Supabase:", error.message);
        }
    }

    // PC -> 모바일 (상태 수신 리스너)
    function listenForPCState() {
        // ⭐ [Supabase 전환] Realtime Listener 사용 ⭐
        supabase
            .channel(`pc_state_${SESSION_ID}`) // 고유 채널 이름 사용
            .on(
                'postgres_changes',
                { 
                    event: 'UPDATE', 
                    schema: 'public', 
                    table: TABLE_NAME,
                    filter: `id=eq.${SESSION_ID}` // 해당 세션 ID의 row만 필터링
                },
                (payload) => {
                    const state = payload.new.pcState; // 업데이트된 row의 pcState 필드 접근
                    if (state) {
                        updateControllerUI(state);
                        // 첫 연결 시 로딩 화면 숨김
                        if (loadingScreen.style.display !== 'none') {
                            loadingScreen.style.display = 'none';
                            mainController.style.display = 'flex';
                            connectionStatus.textContent = '연결됨';
                        }
                    }
                }
            )
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    console.log("Supabase Realtime Subscribed for PC state.");
                } else if (status === 'CHANNEL_ERROR') {
                    connectionStatus.textContent = '연결 오류!';
                    console.error("Supabase Channel Error!");
                }
            });
    }

    // =========================================================================
    // ⭐ UI 및 이벤트 처리 로직 ⭐
    // =========================================================================

    // PC 상태 기반으로 UI 업데이트
    function updateControllerUI(newState) {
        pcState = newState;
        selectedDecoIds = pcState.selectedIds || [];
        
        sceneIndicator.textContent = `SCENE ${pcState.scene || '?'}`;
        
        const currentDecoList = pcState.decoList || [];
        
        // 아이템 목록 렌더링
        selectedListDiv.innerHTML = '';
        if (currentDecoList.length === 0) {
            selectedListDiv.innerHTML = '<div class="no-item">PC 화면에 장식을 추가하세요.</div>';
        } else {
            currentDecoList.forEach(deco => {
                const isSelected = selectedDecoIds.includes(deco.id);
                const itemEl = document.createElement('div');
                itemEl.className = `selected-item ${isSelected ? 'selected' : ''}`;
                itemEl.dataset.id = deco.id;
                itemEl.textContent = `ID: ${deco.id.substring(0, 8)}...`; // 간략 ID 표시
                
                itemEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // 클릭하여 선택/해제 명령 전송
                    sendCommandToPC('item_click', { id: deco.id });
                });
                
                selectedListDiv.appendChild(itemEl);
            });
        }
        
        // 조작 버튼 활성화/비활성화
        const isActive = selectedDecoIds.length > 0;
        controlButtons.forEach(btn => {
            btn.disabled = !isActive;
            btn.classList.toggle('disabled', !isActive);
        });
        joystickControl.classList.toggle('disabled', !isActive);

        // 조이스틱 위치 업데이트 (선택된 아이템이 1개일 때만)
        if (selectedDecoIds.length === 1) {
            const selectedId = selectedDecoIds[0];
            const selectedDeco = currentDecoList.find(d => d.id === selectedId);
            if (selectedDeco) {
                // PC에서 받은 정규화된 좌표로 조이스틱 위치 설정 (초기화)
                setJoystickPositionByNormalized(selectedDeco.x_mobile, selectedDeco.y_mobile);
            }
        } else {
            // 다중 선택 또는 미선택 시 조이스틱 초기 위치
            resetJoystickPosition();
        }
    }
    
    // --- 조이스틱 로직 ---

    function resetJoystickPosition() {
        joystickControl.style.left = '50%';
        joystickControl.style.top = '50%';
        joystickControl.style.transform = 'translate(-50%, -50%)';
        joystickCenter.style.transform = 'translate(-50%, -50%)';
    }

    function setJoystickPositionByNormalized(normalizedY, normalizedX) {
        // PC Y축 정규화 값(0~1)이 모바일 조이스틱의 세로(Top) 위치에 해당
        // PC X축 정규화 값(0~1)이 모바일 조이스틱의 가로(Left) 위치에 해당
        
        // (주의: 조이스틱 영역은 캔버스 전체가 아니라 부모 div 내부이므로 0~100%로 설정)
        // 모바일 조이스틱은 부모(.joystick-area)를 기준으로 위치를 설정해야 합니다.

        const newLeft = normalizedX * 100; // 0% ~ 100%
        const newTop = normalizedY * 100;  // 0% ~ 100%
        
        // 조이스틱의 부모 영역(joystick-area) 내에서 좌표를 설정
        // 이 때 transform: translate(-50%, -50%)를 사용하면 중앙 정렬이 되므로,
        // (0,0) ~ (100,100) 범위로 움직이게 합니다.
        
        joystickControl.style.left = `${newLeft}%`;
        joystickControl.style.top = `${newTop}%`;
        joystickControl.style.transform = 'translate(-50%, -50%)'; // 항상 중앙 정렬 유지
        joystickCenter.style.transform = 'translate(0, 0)'; // 조이스틱 중앙 마커는 움직이지 않음
    }

    // 마우스/터치 시작
    joystickControl.addEventListener('mousedown', startDrag);
    joystickControl.addEventListener('touchstart', startDrag);

    function startDrag(e) {
        if (selectedDecoIds.length !== 1 || e.target.closest('.joystick-center')) return;
        e.preventDefault();
        
        isDragging = true;
        joystickRect = joystickControl.parentNode.getBoundingClientRect();
        joystickCenterRect = joystickCenter.getBoundingClientRect();
        
        const event = e.touches ? e.touches[0] : e;
        
        document.addEventListener('mousemove', drag);
        document.addEventListener('touchmove', drag);
        document.addEventListener('mouseup', stopDrag);
        document.addEventListener('touchend', stopDrag);
    }

    // 드래그 중
    function drag(e) {
        if (!isDragging || selectedDecoIds.length !== 1) return;
        const now = Date.now();
        if (now < lastMoveCommand + THROTTLE_TIME_MOVE) return;
        
        const event = e.touches ? e.touches[0] : e;
        
        let x = event.clientX - joystickRect.left;
        let y = event.clientY - joystickRect.top;
        
        // 경계 제한 (부모 요소 범위)
        x = Math.max(0, Math.min(x, joystickRect.width));
        y = Math.max(0, Math.min(y, joystickRect.height));

        // UI 업데이트 (조이스틱을 마우스 위치로 이동)
        joystickControl.style.left = `${x}px`;
        joystickControl.style.top = `${y}px`;
        joystickControl.style.transform = 'translate(-50%, -50%)'; 

        // 정규화된 좌표 계산 (PC에 전송할 값)
        const normalizedX = x / joystickRect.width; // 0 ~ 1
        const normalizedY = y / joystickRect.height; // 0 ~ 1

        // 명령 전송 (선택된 아이템 1개에 대해서만)
        sendCommandToPC('control_one', {
            id: selectedDecoIds[0],
            x_mobile: normalizedY, // PC의 Y축 정규화 값으로 변환
            y_mobile: normalizedX  // PC의 X축 정규화 값으로 변환
        });

        lastMoveCommand = now;
    }

    // 드래그 종료
    function stopDrag() {
        if (isDragging) {
            isDragging = false;
            document.removeEventListener('mousemove', drag);
            document.removeEventListener('touchmove', drag);
            document.removeEventListener('mouseup', stopDrag);
            document.removeEventListener('touchend', stopDrag);
            
            // 조작 종료 후 PC에 상태를 다시 요청하여 싱크를 맞춥니다.
            // (조이스틱 UI는 PC에서 오는 응답으로 재설정됨)
            // Supabase 리스너가 알아서 처리하므로 별도의 요청은 필요하지 않습니다.
        }
    }
    
    // --- 버튼 조작 로직 ---

    controlButtons.forEach(button => {
        button.addEventListener('click', () => {
            const action = button.dataset.action;
            const direction = button.dataset.direction;

            if (selectedDecoIds.length === 0) return;

            let commandAction = 'control_multi';
            let commandData = { ids: selectedDecoIds };

            if (action === 'delete') {
                commandAction = 'delete_multi';
            } else if (action === 'flip') {
                commandData = { ids: selectedDecoIds };
            } else if (action === 'scale' || action === 'rotate') {
                commandData = { ids: selectedDecoIds, direction: direction, action: action };
            }

            sendCommandToPC(commandAction, commandData);
        });
    });

    // --- 초기 실행 ---
    listenForPCState();
});
