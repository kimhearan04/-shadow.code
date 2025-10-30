// index.js (Supabase Realtime 통신 버전)

document.addEventListener('DOMContentLoaded', () => {

    // ❗️ 전역 'supabase' 객체가 index.html에서 초기화되었다고 가정합니다.

    // --- 1. 기본 변수 설정 ---
    let SESSION_ID = new URLSearchParams(window.location.search).get('session') || `session_${Math.random().toString(36).substring(2, 9)}`;
    
    // --- DOM 요소 및 데이터 ---
    const canvas = document.getElementById('canvas');
    const openControllerBtn = document.getElementById('open-controller-btn');
    const verticalGuide = document.querySelector('.vertical-guide');
    const horizontalGuide = document.querySelector('.horizontal-guide');
    const qrModal = document.getElementById('qr-modal');
    const qrcodeDiv = document.getElementById('qrcode-container'); 
    const controllerStatus = document.getElementById('controller-status');

    const storyData = {
        '1': { background: '', decorations: [] }, '2': { background: '', decorations: [] },
        '3': { background: '', decorations: [] }, '4': { background: '', decorations: [] },
        '5': { background: '', decorations: [] }, '6': { background: '', decorations: [] },
        '7': { background: '', decorations: [] }, '8': { background: '', decorations: [] }
    };
    let currentScene = '1';
    let selectedDecoIds = []; 
    let toastTimer = null;
    let realtimeChannel = null; // Supabase Realtime Channel

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
    // ⭐ Supabase 통신 로직 ⭐
    // =========================================================================
    
    /**
     * PC 상태를 Supabase 데이터베이스에 저장/동기화합니다.
     * (Supabase의 기본 Table/Row 구조에 맞게 데이터를 변환해야 합니다.)
     */
    async function syncStateToSupabase() {
        if (!window.supabase) return;

        const currentData = storyData[currentScene];
        const selectedId = selectedDecoIds.length ? selectedDecoIds[0] : null;

        try {
            // Upsert (Insert or Update) 방식으로 game_state 테이블에 저장
            const { data, error } = await supabase
                .from('game_state') // 테이블 이름 가정
                .upsert({ 
                    id: SESSION_ID, // 세션 ID를 Primary Key로 사용
                    scene: currentScene,
                    state_data: currentData, // JSONB 타입으로 저장
                    selected_deco_id: selectedId
                }, { onConflict: 'id' });

            if (error) throw error;
            // console.log('Supabase 상태 동기화 성공:', data);

            // 모바일 컨트롤러 UI 업데이트 (선택된 아이템 목록)
            updateControllerSelectionUI(currentData.decorations, selectedId);

        } catch (error) {
            console.error('Supabase 상태 동기화 실패:', error.message);
        }
    }

    /**
     * Supabase Realtime 채널을 통해 모바일 컨트롤러의 명령을 수신합니다.
     */
    function listenForControlCommands() {
        if (!window.supabase) return;
        
        // 이전 채널이 있다면 언로드 (씬 변경 시 필요)
        if (realtimeChannel) {
            supabase.removeChannel(realtimeChannel);
        }

        // 새로운 Realtime 채널 생성 및 구독
        realtimeChannel = supabase
            .channel(`controller:${SESSION_ID}`) // 고유한 채널 이름 사용
            .on('postgres_changes', { 
                event: 'INSERT', 
                schema: 'public', 
                table: 'controller_commands', // 명령을 받는 테이블 이름 가정
                filter: `session_id=eq.${SESSION_ID}` // 현재 세션 ID 필터링
            }, (payload) => {
                const command = payload.new;
                
                if (command.action && command.target_id) {
                    console.log('Control Command Received:', command);
                    // 명령을 처리하는 로직 호출
                    handleRemoteCommand(command.target_id, command.action, command.value);
                }

                // 명령을 사용한 후 DB에서 삭제 (선택 사항이지만 Realtime 충돌 방지 및 깔끔한 관리를 위해 권장)
                supabase
                    .from('controller_commands')
                    .delete()
                    .eq('id', command.id)
                    .then(({ error }) => {
                        if (error) console.error('Command cleanup error:', error);
                    });
            })
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    console.log('Supabase Realtime Channel 구독 성공:', SESSION_ID);
                    if (controllerStatus) controllerStatus.textContent = '✅ 연결됨';
                    // 초기 상태 동기화 시도
                    syncStateToSupabase();
                } else if (status === 'CHANNEL_ERROR') {
                    console.error('Supabase Realtime Channel 오류');
                    if (controllerStatus) controllerStatus.textContent = '❌ 연결 실패';
                }
            });
    }

    /**
     * 모바일 컨트롤러 명령 처리 로직
     * (Firebase 버전과 동일한 로직을 재사용)
     */
    function handleRemoteCommand(targetId, action, value = null) {
        let deco = storyData[currentScene].decorations.find(d => d.id === targetId);
        if (!deco) return;

        // 아이템이 선택되지 않았다면 선택 처리
        if (!selectedDecoIds.includes(targetId)) {
            // 다른 아이템 선택 해제
            selectedDecoIds.forEach(id => {
                const item = document.getElementById(id);
                if (item) item.classList.remove('selected');
            });
            selectedDecoIds = [targetId];
            const itemElement = document.getElementById(targetId);
            if (itemElement) itemElement.classList.add('selected');
        }
        
        const itemElement = document.getElementById(targetId);
        if (!itemElement) return;
        
        switch (action) {
            case 'move':
                // value: { deltaX: number, deltaY: number }
                if (value && value.deltaX !== undefined && value.deltaY !== undefined) {
                    deco.x += value.deltaX * 0.5; // 민감도 조정
                    deco.y += value.deltaY * 0.5;
                    // 캔버스 경계 보정 (이 로직은 PC 드래그 로직에서 가져와야 함)
                    applyBoundaryCheck(deco, itemElement); 
                }
                break;
            case 'scale-up':
                deco.scale = Math.min(2.0, deco.scale + 0.05);
                break;
            case 'scale-down':
                deco.scale = Math.max(0.2, deco.scale - 0.05);
                break;
            case 'rotate-right':
                deco.rotation = (deco.rotation + 5) % 360;
                break;
            case 'rotate-left':
                deco.rotation = (deco.rotation - 5 + 360) % 360;
                break;
            case 'flip':
                deco.isFlipped = !deco.isFlipped;
                break;
            case 'delete':
                deleteDecoration(targetId);
                return; // 삭제 후에는 스타일 업데이트 불필요
            default:
                console.warn('Unknown command:', action);
                return;
        }

        // 로컬 스타일 업데이트
        updateDecoStyle(itemElement, deco);
        // Supabase에 변경된 상태 다시 동기화
        syncStateToSupabase();
    }
    
    // =========================================================================
    // ⭐ PC 메인 웹사이트 모드 로직 (로컬) ⭐
    // =========================================================================

    // ... (이전 index.js의 나머지 로직 유지) ...
    // 다만, 모든 로컬 상태 변경 후에는 `syncStateToSupabase()`를 호출해야 합니다.

    // -----------------------------------------------------------
    // [중요] 기존 로컬 함수에 `syncStateToSupabase()` 추가 (예시)
    // -----------------------------------------------------------

    function deleteDecoration(id) {
        // ... (삭제 로직) ...
        const index = storyData[currentScene].decorations.findIndex(d => d.id === id);
        if (index > -1) {
            storyData[currentScene].decorations.splice(index, 1);
            const itemElement = document.getElementById(id);
            if (itemElement) itemElement.remove();
        }
        selectedDecoIds = selectedDecoIds.filter(selId => selId !== id);
        
        // 🚨 Supabase 동기화 추가 🚨
        syncStateToSupabase();
    }

    function switchScene(newScene) {
        // ... (씬 전환 로직) ...
        currentScene = newScene;
        selectedDecoIds = [];
        renderScene();
        // 🚨 Supabase 동기화 및 리스너 재시작 추가 🚨
        syncStateToSupabase();
        listenForControlCommands();
    }
    
    // ... (모든 상태 변경 함수에 syncStateToSupabase() 호출 추가 필요) ...

    // --- 초기화 ---
    renderScene(); // 캔버스 초기 렌더링
    
    // 모바일 연결 버튼 클릭 핸들러
    if (openControllerBtn) {
        openControllerBtn.addEventListener('click', () => {
            if (qrModal) qrModal.style.display = 'flex';
            generateQRCode();
            // 컨트롤러 명령 리스닝 시작
            listenForControlCommands(); 
        });
    }

    /**
     * QR 코드 생성 함수 (세션 ID 사용)
     */
    function generateQRCode() {
        if (!qrcodeDiv || !window.QRCode) return;

        // 기존 QR 코드 초기화
        qrcodeDiv.innerHTML = ''; 

        // 모바일 컨트롤러 URL (예시: 실제 서버 주소로 변경 필요)
        const controllerUrl = `https://your-mobile-controller-url.com/?session=${SESSION_ID}`;
        
        new QRCode(qrcodeDiv, {
            text: controllerUrl,
            width: 256,
            height: 256,
            colorDark: "#000000",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.H
        });
        console.log("QR Code generated for session:", SESSION_ID);
    }

    // 🚨 나머지 로컬 기능 (드래그, 리사이즈, 타임라인 클릭 등)의 상세 로직은
    // 🚨 이전 코드와 동일하게 유지되어야 합니다.
    // 🚨 이 예시에서는 통신 관련 부분만 수정했음을 알려드립니다.

    // ... (드래그 및 리사이즈 로직, 타임라인 로직 등) ...

    // --- 컨트롤러 선택 UI 업데이트 함수 (Supabase 동기화 로직에서 호출) ---
    function updateControllerSelectionUI(decorations, selectedId) {
        const selectionDiv = document.getElementById('deco-selection');
        if (!selectionDiv) return;

        selectionDiv.innerHTML = '';
        decorations.forEach(deco => {
            const btn = document.createElement('button');
            btn.textContent = deco.type.substring(0, 1) + deco.id.substring(deco.id.length - 2); // 예: D-12
            btn.className = 'ctrl-select-btn';
            btn.dataset.id = deco.id;
            btn.style.padding = '8px';
            btn.style.background = deco.id === selectedId ? '#4F99B2' : '#e0e0e0';
            btn.style.color = deco.id === selectedId ? 'white' : '#333';
            btn.style.border = 'none';
            btn.style.borderRadius = '5px';
            btn.style.cursor = 'pointer';
            
            // 이 버튼은 PC UI에 표시되지만, 모바일 컨트롤러의 상태를 시뮬레이션합니다.
            // 실제 모바일 컨트롤러는 별도로 구현해야 합니다.
            
            selectionDiv.appendChild(btn);
        });
    }

    // ... (생략된 기존 로컬 기능) ... 

    // --- 초기 Supabase Realtime 리스너 시작 (선택 사항: 페이지 로드 시 바로 시작) ---
    // listenForControlCommands(); 

}); // DOMContentLoaded 끝
}); // DOMContentLoaded 끝
