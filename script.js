import * as THREE from 'three';
import { marked } from "marked";
import DOMPurify from "dompurify";

const room = new WebsimSocket();

const statusText = document.getElementById('status-text');
const threeContainer = document.getElementById('three-container');
const webcamFeed = document.getElementById('webcam-feed');
const liveCommentsContainer = document.getElementById('live-comments-container');
const outputCanvas = document.getElementById('output-canvas');
const canvasCtx = outputCanvas.getContext('2d');

let scene, camera, renderer, skeletonGroup;
let isHost = false;
let hostId = null;
let ytPlayer;

// --- Main Initialization ---
// Attach the initialization trigger to the window object
// so it can be called after MediaPipe is ready.
window.onMediaPipeLoaded = main;

// The mediapipe script in index.html will load, and then we'll call main().
// A small delay ensures the Pose object is available on the window.
setTimeout(() => {
    if (window.Pose && window.Camera) {
        main();
    } else {
        console.error("MediaPipe libraries not found after timeout.");
        statusText.textContent = "Error loading tracking library. Please refresh.";
    }
}, 500);

async function main() {
    // Prevent double initialization
    if (window.appInitialized) return;
    window.appInitialized = true;

    try {
        const [project, creator, currentUser] = await Promise.all([
            window.websim.getCurrentProject(),
            window.websim.getCreator(),
            window.websim.getCurrentUser()
        ]);
        
        hostId = creator.id;
        isHost = currentUser.id === hostId;

        await room.initialize();

        setupThreeScene();
        setupYoutube();
        setupCommentSystem(project.id);
        
        if (isHost) {
            statusText.textContent = 'Starting up webcam and tracking...';
            setupMediaPipe();
        }

        room.subscribePresence(handlePresenceUpdate);
        room.subscribeRoomState(handleRoomStateUpdate);
        
        // Initial sync of state
        handlePresenceUpdate();
        handleRoomStateUpdate();
        
        animate();

    } catch (error) {
        console.error("Initialization failed:", error);
        statusText.textContent = "Error initializing. Please refresh.";
    }
}

// --- 3D Skeleton Rendering (Three.js) ---
function setupThreeScene() {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, threeContainer.clientWidth / threeContainer.clientHeight, 0.1, 1000);
    camera.position.z = 1.5;

    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(threeContainer.clientWidth, threeContainer.clientHeight);
    threeContainer.appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(0, 1, 1);
    scene.add(directionalLight);

    createSkeleton();
    
    window.addEventListener('resize', onWindowResize, false);
}

function createSkeleton() {
    skeletonGroup = new THREE.Group();
    const material = new THREE.MeshPhongMaterial({ color: 0xbb86fc });

    // Create spheres for joints
    for (let i = 0; i < 33; i++) {
        const geometry = new THREE.SphereGeometry(0.02, 16, 16);
        const joint = new THREE.Mesh(geometry, material);
        joint.visible = false;
        skeletonGroup.add(joint);
    }

    // Create cylinders for bones
    // Ensure Pose is loaded before trying to access POSE_CONNECTIONS
    if (window.Pose && window.Pose.POSE_CONNECTIONS) {
        const boneMaterial = new THREE.LineBasicMaterial({ color: 0x03dac6, linewidth: 3, transparent: true, opacity: 0.75 });
        const connections = window.Pose.POSE_CONNECTIONS;
        for (const connection of connections) {
            const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,0)]);
            const bone = new THREE.Line(geometry, boneMaterial);
            bone.visible = false;
            skeletonGroup.add(bone);
        }
    } else {
        console.error("Pose library not loaded correctly, cannot create skeleton bones.");
    }

    scene.add(skeletonGroup);
}

function updateSkeleton(landmarks) {
    if (!landmarks || !skeletonGroup) return;

    skeletonGroup.children.forEach(child => child.visible = true);
    statusText.style.display = 'none';

    // Update joints
    for (let i = 0; i < 33; i++) {
        const landmark = landmarks[i];
        const joint = skeletonGroup.children[i];
        // Center and scale the pose
        joint.position.set(
            -(landmark.x - 0.5) * 2, 
            -(landmark.y - 0.5) * 2, 
            -landmark.z * 2
        );
    }
    
    // Update bones
    if (window.Pose && window.Pose.POSE_CONNECTIONS) {
        const connections = window.Pose.POSE_CONNECTIONS;
        for (let i = 0; i < connections.length; i++) {
            const startIdx = connections[i][0];
            const endIdx = connections[i][1];

            if (startIdx >= landmarks.length || endIdx >= landmarks.length) continue;

            const startPos = skeletonGroup.children[startIdx].position;
            const endPos = skeletonGroup.children[endIdx].position;
            
            const bone = skeletonGroup.children[33 + i];
            if (bone) {
                bone.geometry.setFromPoints([startPos, endPos]);
                bone.geometry.verticesNeedUpdate = true;
            }
        }
    }
}

function onWindowResize() {
    camera.aspect = threeContainer.clientWidth / threeContainer.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(threeContainer.clientWidth, threeContainer.clientHeight);
}

function animate() {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
}

// --- Host Body Tracking (MediaPipe) ---
function setupMediaPipe() {
    const pose = new Pose({locateFile: (file) => {
      return `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`;
    }});
    
    pose.setOptions({
      modelComplexity: 1,
      smoothLandmarks: true,
      enableSegmentation: false,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });

    pose.onResults(onPoseResults);

    const camera = new Camera(webcamFeed, {
        onFrame: async () => {
            await pose.send({image: webcamFeed});
        },
        width: 640,
        height: 480
    });
    camera.start();
    statusText.textContent = 'Look at the camera!';
}

function onPoseResults(results) {
    if (results.poseWorldLandmarks) {
        room.updatePresence({ pose: results.poseWorldLandmarks, userId: hostId });
    }
    
    // We can use the canvas to debug if needed by drawing landmarks, but for now it's not necessary
    // canvasCtx.save();
    // canvasCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
    // canvasCtx.drawImage(results.image, 0, 0, outputCanvas.width, outputCanvas.height);
    // drawConnectors(canvasCtx, results.poseLandmarks, POSE_CONNECTIONS, {color: '#00FF00', lineWidth: 4});
    // drawLandmarks(canvasCtx, results.poseLandmarks, {color: '#FF0000', lineWidth: 2});
    // canvasCtx.restore();
}

// --- Multiplayer Sync (WebsimSocket) ---
function handlePresenceUpdate() {
    const hostPresence = Object.values(room.presence).find(p => p.userId === hostId);
    if (hostPresence && hostPresence.pose) {
        updateSkeleton(hostPresence.pose);
    } else {
        if (skeletonGroup) {
            skeletonGroup.children.forEach(c => c.visible = false);
        }
        statusText.style.display = 'block';
        statusText.textContent = 'Waiting for the host to start dancing...';
    }
}

function handleRoomStateUpdate() {
    if (ytPlayer && room.roomState.youtube) {
        const { videoId, time, isPlaying } = room.roomState.youtube;
        const currentPlayerId = ytPlayer.getVideoData()['video_id'];
        
        if (videoId && videoId !== currentPlayerId) {
            ytPlayer.loadVideoById(videoId, time);
        } else {
            const playerState = ytPlayer.getPlayerState();
            if (isPlaying && playerState !== YT.PlayerState.PLAYING) {
                ytPlayer.seekTo(time, true);
                ytPlayer.playVideo();
            } else if (!isPlaying && playerState === YT.PlayerState.PLAYING) {
                ytPlayer.pauseVideo();
                ytPlayer.seekTo(time, true);
            }
        }
    }
}

// --- YouTube Player ---
function setupYoutube() {
    const urlInput = document.getElementById('youtube-url-input');
    const urlSubmit = document.getElementById('youtube-url-submit');

    urlSubmit.addEventListener('click', () => {
        const url = urlInput.value;
        const videoId = extractVideoId(url);
        if (videoId) {
            room.updateRoomState({
                youtube: { videoId, time: 0, isPlaying: true }
            });
            urlInput.value = '';
        } else {
            alert('Invalid YouTube URL');
        }
    });
}

function extractVideoId(url) {
    const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
}

window.onYouTubeIframeAPIReady = function() {
    ytPlayer = new YT.Player('youtube-player', {
        height: '100%',
        width: '100%',
        playerVars: { 'autoplay': 0, 'controls': 1 },
        events: {
            'onStateChange': onPlayerStateChange
        }
    });
};

function onPlayerStateChange(event) {
    // Only the host's player controls the state to prevent conflicts
    if (!isHost) return;

    const isPlaying = event.data === YT.PlayerState.PLAYING;
    const time = ytPlayer.getCurrentTime();
    const videoData = ytPlayer.getVideoData();
    const videoId = videoData ? videoData['video_id'] : null;

    if (videoId) {
        room.updateRoomState({
            youtube: { ...room.roomState.youtube, videoId, time, isPlaying }
        });
    }
}


// --- Comment System ---
function setupCommentSystem(projectId) {
    const commentInput = document.getElementById('comment-input');
    const tipInput = document.getElementById('tip-input');
    const submitBtn = document.getElementById('submit-comment');

    submitBtn.addEventListener('click', async () => {
        const content = commentInput.value.trim();
        const credits = parseInt(tipInput.value, 10);

        if (!content) return;

        const payload = { content };
        if (credits && credits >= 10) {
            payload.credits = credits;
        }

        try {
            await window.websim.postComment(payload);
            commentInput.value = '';
            tipInput.value = '';
        } catch (e) {
            console.error("Failed to post comment:", e);
            alert("Could not post comment. You might need to interact with the page first.");
        }
    });

    loadInitialComments(projectId);

    window.websim.addEventListener('comment:created', (data) => {
        addCommentToUI(data.comment, true);
    });
}

async function loadInitialComments(projectId) {
    try {
        const response = await fetch(`/api/v1/projects/${projectId}/comments?last=20`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        const comments = data.comments.data.map(c => c.comment).reverse();
        for (const comment of comments) {
            addCommentToUI(comment, false);
        }
    } catch (error) {
        console.error("Failed to load comments:", error);
    }
}

function addCommentToUI(comment, isNew) {
    const commentHtml = DOMPurify.sanitize(marked.parse(comment.raw_content || ''));
    const isTip = comment.card_data && comment.card_data.type === 'tip_comment';

    // Add to side panel
    const list = document.getElementById('comments-list');
    const item = document.createElement('div');
    item.className = 'comment-item';
    if(isTip) item.classList.add('tip');

    item.innerHTML = `
        <div class="author">
            <img src="${comment.author.avatar_url || ''}" alt="${comment.author.username}'s avatar">
            <span>${comment.author.username}</span>
        </div>
        <div class="content">${commentHtml}</div>
        ${isTip ? `<div class="tip-amount">Tipped ${comment.card_data.credits_spent} credits!</div>` : ''}
    `;
    list.appendChild(item);
    list.scrollTop = list.scrollHeight;
    
    // If it's a new comment, show it on the live feed
    if (isNew) {
        const liveComment = document.createElement('div');
        liveComment.className = 'live-comment';
        if (isTip) liveComment.classList.add('tip');
        liveComment.innerHTML = item.innerHTML;
        liveCommentsContainer.prepend(liveComment);

        // Clean up after animation
        setTimeout(() => liveComment.remove(), 10000);
    }
}