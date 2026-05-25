"""
sudo nmcli device wifi hotspot ifname wlP1p1s0 ssid "Jetson_test_wifi" password "12345678"
echo 3 | sudo tee /proc/sys/vm/drop_caches
使用方法：
  - 相机模式：python open_path.py
  - 视频测试：python open_path.py --video test_video.mp4
  python open_path.py --video video/park1.mp4
"""

from ultralytics import YOLO
import cv2
import math 
import torch
import time
import numpy as np
import logging
import sys
import argparse
from queue import Queue, Empty
import subprocess
import threading
import tempfile
import os
import glob
from scipy.io.wavfile import read, write
from collections import deque
import shutil
import fluidsynth
import pandas as pd
from haptic_mqtt_controller import HapticMQTTController

parser = argparse.ArgumentParser(description='Curb Detection System')
parser.add_argument('--video', type=str, default=None, 
                    help='Path to video file for testing (skips camera and disables fisheye correction)')
args = parser.parse_args()

VIDEO_TEST_MODE = args.video is not None
VIDEO_PATH = args.video

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ========== 导入模块 ==========
try:
    if not VIDEO_TEST_MODE:
        from gstreamer_dual_camera import GStreamerDualCamera
        GSTREAMER_AVAILABLE = True
        logger.info("✅ GStreamer available")
    else:
        GSTREAMER_AVAILABLE = False
        logger.info("📹 Video test mode - GStreamer not needed")
except ImportError as e:
    GSTREAMER_AVAILABLE = False
    logger.warning(f"⚠️  GStreamer not available: {e}")

from complete_audio_player import CompletePrerecordedAudio, generate_guidance_text
from simple_profiler_decorator import profile_code_block, tracker

# ========== 全局退出标志 ==========
exit_flag = threading.Event()

# ========== 键盘监听线程 ==========
class KeyboardListener(threading.Thread):
    def __init__(self):
        super().__init__()
        self.daemon = True
        
    def run(self):
        logger.info("💡 Press 'q' + Enter to quit")
        try:
            while not exit_flag.is_set():
                user_input = input()
                if user_input.lower() == 'q':
                    logger.info("🛑 'q' pressed, initiating shutdown...")
                    exit_flag.set()
                    break
        except EOFError:
            pass
        except Exception as e:
            logger.error(f"Keyboard listener error: {e}")

# ========== 配置参数 ==========
if VIDEO_TEST_MODE:
    logger.info(f"📹 Video test mode: {VIDEO_PATH}")
    CAMERA_DEVICE = None
    CAMERA_WIDTH = 640
    CAMERA_HEIGHT = 480
    CAMERA_FPS = 30
    FISHEYE_ENABLED = False
    logger.info("✅ Fisheye correction disabled for video testing")
else:
    CAMERA_DEVICE = '/dev/video0'
    CAMERA_WIDTH = 640
    CAMERA_HEIGHT = 480
    CAMERA_FPS = 30
    FISHEYE_ENABLED = False

CALIBRATION_FILE = "calibration_data_jetson.npz"
FISHEYE_BALANCE = 0.0

def generate_camera_output_filename(base_dir=".", prefix="camera", extension=".mp4"):
    existing_files = glob.glob(os.path.join(base_dir, f"{prefix}_*{extension}"))
    indices = [int(os.path.splitext(os.path.basename(file))[0].split('_')[-1]) 
               for file in existing_files 
               if file.split('_')[-1].replace(extension, '').isdigit()]
    next_index = max(indices) + 1 if indices else 1
    return os.path.join(base_dir, f"{prefix}_{next_index}{extension}")

# ========== 加载鱼眼校正 ==========
fisheye_enabled = False
K, D = None, None

if FISHEYE_ENABLED and os.path.exists(CALIBRATION_FILE):
    try:
        logger.info(f"Loading calibration: {CALIBRATION_FILE}")
        data = np.load(CALIBRATION_FILE)
        K = data["K"]
        D = data["D"]
        fisheye_enabled = True
        logger.info("✅ Fisheye calibration loaded")
    except Exception as e:
        logger.error(f"Failed to load calibration: {e}")
else:
    if VIDEO_TEST_MODE:
        logger.info("ℹ️  Fisheye correction disabled for video testing")
    else:
        logger.warning(f"Calibration file not found: {CALIBRATION_FILE}")

# ========== 初始化视频源 ==========
def initialize_video_source():
    if VIDEO_TEST_MODE:
        logger.info(f"📹 Opening video file: {VIDEO_PATH}")
        
        if not os.path.exists(VIDEO_PATH):
            raise FileNotFoundError(f"Video file not found: {VIDEO_PATH}")
        
        cap = cv2.VideoCapture(VIDEO_PATH)
        
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open video file: {VIDEO_PATH}")
        
        frame_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        frame_rate = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        
        logger.info(f"✅ Video loaded: {frame_width}x{frame_height} @ {frame_rate:.1f}fps, {total_frames} frames")
        
        return cap, "video", frame_width, frame_height, frame_rate
    
    else:
        if GSTREAMER_AVAILABLE:
            logger.info("🔧 Initializing GStreamer camera...")
            
            try:
                cap = GStreamerDualCamera(
                    device=CAMERA_DEVICE,
                    width=CAMERA_WIDTH,
                    height=CAMERA_HEIGHT,
                    fps=CAMERA_FPS,
                    use_hw_decoder=False,
                    output_format='display'
                )
                
                frame_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                frame_rate = cap.get(cv2.CAP_PROP_FPS) or 30.0
                
                logger.info(f"✅ GStreamer camera initialized: {frame_width}x{frame_height} @ {frame_rate:.1f}fps")
                
                return cap, "gstreamer", frame_width, frame_height, frame_rate
                
            except Exception as e:
                logger.error(f"GStreamer failed: {e}")
                raise
        
        else:
            raise RuntimeError("Camera mode requires GStreamer. Use --video for testing with video files.")

# ========== 初始化系统 ==========
logger.info("="*60)
logger.info("🚀 INITIALIZING SYSTEM")
logger.info("="*60)

cap, video_source_type, frame_width, frame_height, frame_rate = initialize_video_source()

logger.info("="*60)
logger.info(f"📐 Frame dimensions: {frame_width}x{frame_height}")
logger.info(f"📏 Total area: {frame_width * frame_height}")
logger.info(f"🎥 Source type: {video_source_type}")
logger.info("="*60)

device = 'cuda' if torch.cuda.is_available() else 'cpu'
logger.info(f"Loading YOLO model on {device}...")
model = YOLO("best.pt").to(device)
logger.info("✅ YOLO model loaded")

map1, map2 = None, None
if fisheye_enabled:
    try:
        logger.info("Generating undistortion maps...")
        new_K = cv2.fisheye.estimateNewCameraMatrixForUndistortRectify(
            K, D, (frame_width, frame_height), np.eye(3), balance=FISHEYE_BALANCE
        )
        map1, map2 = cv2.fisheye.initUndistortRectifyMap(
            K, D, np.eye(3), new_K, (frame_width, frame_height), cv2.CV_16SC2
        )
        logger.info("✅ Undistortion maps ready")
    except Exception as e:
        logger.error(f"Failed to generate maps: {e}")
        fisheye_enabled = False

out = None
if not VIDEO_TEST_MODE and video_source_type != "gstreamer":
    output_file = generate_camera_output_filename()
    fourcc = cv2.VideoWriter_fourcc(*'XVID')
    out = cv2.VideoWriter(output_file, fourcc, frame_rate, (frame_width, frame_height))
    logger.info(f"Output: {output_file}")

logger.info("="*60)

# ========== 类别和颜色 ==========
classNames = ["curb_down", "curb_up", "road", "sidewalk"]

class_colors = {
    0: (0, 0, 255),
    1: (0, 255, 255),
    2: (0, 255, 0),
    3: (255, 0, 255)
}

color_mapping = {
    range(0, 3): ((0, 0, 255), 1),
    range(3, 6): ((0, 225, 255), 2)
}

position_direction_mapping = {
    0: 'left',
    1: 'front',
    2: 'right',
    3: 'left',
    4: 'front',
    5: 'right'
}

def get_color_and_object_color(fan_area):
    for key, value in color_mapping.items():
        if fan_area in key:
            return value
    return (255, 0, 255), None

def get_position_direction(fan_area):
    return position_direction_mapping.get(fan_area, "")

# ========== ✅ 新增：SidewalkAnalyzer 类 ==========
class SidewalkAnalyzer:
    """分析sidewalk mask的完整性，检测障碍物/缺口"""
    
    def __init__(self, frame_width, frame_height):
        self.frame_width = frame_width
        self.frame_height = frame_height
        
        # 定义分析区域（只分析画面下半部分，用户前方区域）
        self.analysis_start_y = int(frame_height * 0.4)  # 从40%高度开始
        self.analysis_end_y = frame_height
        
        # 将宽度分成3个区域：左、中、右
        self.left_x = 0
        self.left_center_x = int(frame_width * 0.33)
        self.right_center_x = int(frame_width * 0.67)
        self.right_x = frame_width
        
        logger.info(f"SidewalkAnalyzer initialized: analyzing y=[{self.analysis_start_y}:{self.analysis_end_y}]")
    
    def analyze_sidewalk_mask(self, sidewalk_mask):
        """
        分析sidewalk mask的完整性
        
        返回:
            - left_density: 左侧区域的sidewalk密度 (0-1)
            - center_density: 中间区域的sidewalk密度 (0-1)
            - right_density: 右侧区域的sidewalk密度 (0-1)
            - best_direction: 最佳方向 ('left', 'center', 'right')
            - sidewalk_top_y: sidewalk的最高点y坐标 ✅ 新增
        """
        
        if sidewalk_mask is None or sidewalk_mask.sum() == 0:
            return 0, 0, 0, None, self.analysis_start_y  # ✅ 返回默认值
        
        # 调整mask大小
        mask_resized = cv2.resize(sidewalk_mask, (self.frame_width, self.frame_height), 
                                interpolation=cv2.INTER_NEAREST)
        
        # ✅ 计算sidewalk的最高点（最小y坐标）
        sidewalk_pixels = np.where(mask_resized > 0)
        if len(sidewalk_pixels[0]) > 0:
            sidewalk_top_y = int(np.min(sidewalk_pixels[0]))
            # 限制最小值，避免太高
            sidewalk_top_y = max(int(self.frame_height * 0.2), sidewalk_top_y)
        else:
            sidewalk_top_y = self.analysis_start_y
        
        # ✅ 使用动态的上边界进行分析
        analysis_start_y = sidewalk_top_y
        analysis_end_y = self.analysis_end_y
        
        # 只分析前方区域
        analysis_region = mask_resized[analysis_start_y:analysis_end_y, :]
        
        # 计算每个区域的总像素数
        region_height = analysis_end_y - analysis_start_y
        left_total_pixels = region_height * (self.left_center_x - self.left_x)
        center_total_pixels = region_height * (self.right_center_x - self.left_center_x)
        right_total_pixels = region_height * (self.right_x - self.right_center_x)
        
        # 计算每个区域的sidewalk像素数
        left_region = analysis_region[:, self.left_x:self.left_center_x]
        center_region = analysis_region[:, self.left_center_x:self.right_center_x]
        right_region = analysis_region[:, self.right_center_x:self.right_x]
        
        left_sidewalk_pixels = np.sum(left_region > 0)
        center_sidewalk_pixels = np.sum(center_region > 0)
        right_sidewalk_pixels = np.sum(right_region > 0)
        
        # 计算密度（sidewalk覆盖率）
        left_density = left_sidewalk_pixels / left_total_pixels if left_total_pixels > 0 else 0
        center_density = center_sidewalk_pixels / center_total_pixels if center_total_pixels > 0 else 0
        right_density = right_sidewalk_pixels / right_total_pixels if right_total_pixels > 0 else 0
        
        # 判断最佳方向
        densities = {
            'left': left_density,
            'center': center_density,
            'right': right_density
        }
        best_direction = max(densities, key=densities.get)
        
        return left_density, center_density, right_density, best_direction, sidewalk_top_y  # ✅ 返回top_y
    
    def visualize_analysis(self, frame, left_density, center_density, right_density, best_direction, sidewalk_top_y=None):
        """在画面上可视化分析结果"""
        
        # ✅ 使用动态的上边界
        if sidewalk_top_y is None:
            sidewalk_top_y = self.analysis_start_y
        
        # 绘制分析区域边界（使用动态的上边界）
        cv2.line(frame, (0, sidewalk_top_y), (self.frame_width, sidewalk_top_y), 
                (255, 255, 0), 2)  # ✅ 改为2像素粗，更明显
        
        # 绘制左中右分隔线（从动态上边界开始）
        cv2.line(frame, (self.left_center_x, sidewalk_top_y), 
                (self.left_center_x, self.analysis_end_y), (255, 255, 0), 1)
        cv2.line(frame, (self.right_center_x, sidewalk_top_y), 
                (self.right_center_x, self.analysis_end_y), (255, 255, 0), 1)
        
        # 显示密度数值（位置根据上边界调整）
        text_y = sidewalk_top_y + 30
        cv2.putText(frame, f"L:{left_density:.2f}", (10, text_y), 
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
        cv2.putText(frame, f"C:{center_density:.2f}", (self.frame_width//2 - 30, text_y), 
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
        cv2.putText(frame, f"R:{right_density:.2f}", (self.frame_width - 80, text_y), 
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
        
        # 高亮最佳方向（使用动态边界）
        if best_direction == 'left':
            cv2.rectangle(frame, (self.left_x, sidewalk_top_y), 
                        (self.left_center_x, self.analysis_end_y), (0, 255, 0), 3)  # ✅ 改为3像素粗
        elif best_direction == 'center':
            cv2.rectangle(frame, (self.left_center_x, sidewalk_top_y), 
                        (self.right_center_x, self.analysis_end_y), (0, 255, 0), 3)
        elif best_direction == 'right':
            cv2.rectangle(frame, (self.right_center_x, sidewalk_top_y), 
                        (self.right_x, self.analysis_end_y), (0, 255, 0), 3)

# ========== ✅ 论文方法：OpenPathAnalyzer 类 ==========
# class OpenPathAnalyzer:
#     """
#     基于论文的 Open Path Mode 实现
#     使用 3x7 网格和 Adjusted Score 算法
#     """
    
#     def __init__(self, frame_width, frame_height):
#         self.frame_width = frame_width
#         self.frame_height = frame_height
        
#         # 定义分析区域（从40%高度到底部）
#         self.analysis_start_y = int(frame_height * 0.4)
#         self.analysis_end_y = frame_height
        
#         # 3x7 网格设置
#         self.grid_rows = 3  # 包含 margin
#         self.grid_cols = 7  # 包含 margin
        
#         # 实际使用的是中间的 2x5 区域
#         self.actual_rows = 2
#         self.actual_cols = 5
        
#         # 计算每个单元格的尺寸
#         self.cell_height = (self.analysis_end_y - self.analysis_start_y) // self.actual_rows
#         self.cell_width = frame_width // self.actual_cols
        
#         logger.info(f"OpenPathAnalyzer initialized:")
#         logger.info(f"  Grid: 3x7 (with margin), Actual: 2x5")
#         logger.info(f"  Cell size: {self.cell_width}x{self.cell_height}")
#         logger.info(f"  Analysis Y: [{self.analysis_start_y}:{self.analysis_end_y}]")
    
#     def analyze_traversable_area(self, traversable_mask):
#         """
#         分析可通行区域，返回最佳方向
        
#         Args:
#             traversable_mask: 可通行区域的 mask（例如 sidewalk mask）
        
#         Returns:
#             best_column: 最佳列索引 (0-4)
#             best_direction: 'left', 'center', 'right'
#             vibration_intensity: 'strong', 'weak', 'none'
#             grid_scores: 3x7 的得分矩阵（用于可视化）
#             sidewalk_top_y: sidewalk的最高点y坐标 ✅ 新增
#         """
        
#         if traversable_mask is None or traversable_mask.sum() == 0:
#             return None, None, 'none', None, self.analysis_start_y  # ✅ 返回默认值
        
#         # Resize mask 到 frame 尺寸
#         mask_resized = cv2.resize(traversable_mask, (self.frame_width, self.frame_height), 
#                                 interpolation=cv2.INTER_NEAREST)
        
#         # ✅ 计算sidewalk的最高点（最小y坐标）
#         sidewalk_pixels = np.where(mask_resized > 0)
#         if len(sidewalk_pixels[0]) > 0:
#             sidewalk_top_y = int(np.min(sidewalk_pixels[0]))
#             # 限制最小值，避免太高（至少保留20%的画面）
#             sidewalk_top_y = max(int(self.frame_height * 0.2), sidewalk_top_y)
#             # 限制最大值，至少要有一些分析区域
#             sidewalk_top_y = min(int(self.frame_height * 0.6), sidewalk_top_y)
#         else:
#             sidewalk_top_y = self.analysis_start_y
        
#         # ✅ 使用动态的上边界进行分析
#         dynamic_analysis_start_y = sidewalk_top_y
#         dynamic_analysis_end_y = self.analysis_end_y
        
#         # 只分析从sidewalk顶部到底部的区域
#         analysis_mask = mask_resized[dynamic_analysis_start_y:dynamic_analysis_end_y, :]
        
#         # ✅ 重新计算单元格高度（基于动态范围）
#         dynamic_height = dynamic_analysis_end_y - dynamic_analysis_start_y
#         dynamic_cell_height = dynamic_height // self.actual_rows
        
#         # 创建 3x7 网格的 raw scores
#         grid_scores = np.zeros((self.grid_rows, self.grid_cols))
        
#         # 计算 2x5 区域的 raw scores
#         for row in range(self.actual_rows):
#             for col in range(self.actual_cols):
#                 # ✅ 使用动态的单元格高度
#                 y_start = row * dynamic_cell_height
#                 y_end = (row + 1) * dynamic_cell_height
#                 x_start = col * self.cell_width
#                 x_end = (col + 1) * self.cell_width
                
#                 # 提取单元格区域
#                 cell_mask = analysis_mask[y_start:y_end, x_start:x_end]
                
#                 # 计算 raw score（可通行像素占比）
#                 total_pixels = cell_mask.size
#                 traversable_pixels = np.sum(cell_mask > 0)
#                 raw_score = traversable_pixels / total_pixels if total_pixels > 0 else 0
                
#                 # 存储到 3x7 网格中（注意 +1 是因为有上方的 margin）
#                 grid_scores[row + 1, col + 1] = raw_score
        
#         # 填充 margin 区域（复制边缘值）
#         # 顶部 margin
#         grid_scores[0, 1:6] = grid_scores[1, 1:6]
#         # 左侧 margin
#         grid_scores[:, 0] = grid_scores[:, 1]
#         # 右侧 margin
#         grid_scores[:, 6] = grid_scores[:, 5]
#         # 角落
#         grid_scores[0, 0] = grid_scores[1, 1]
#         grid_scores[0, 6] = grid_scores[1, 5]
        
#         # 计算 Adjusted Scores（只对 2x5 区域）
#         adjusted_scores = np.zeros((self.actual_rows, self.actual_cols))
        
#         for row in range(self.actual_rows):
#             for col in range(self.actual_cols):
#                 # 在 3x7 网格中的位置
#                 i = row + 1
#                 j = col + 1
                
#                 # 获取邻居
#                 C = grid_scores[i, j]      # 当前
#                 T = grid_scores[i-1, j]    # 上
#                 L = grid_scores[i, j-1]    # 左
#                 R = grid_scores[i, j+1]    # 右
#                 TR = grid_scores[i-1, j+1] # 右上
#                 TL = grid_scores[i-1, j-1] # 左上
                
#                 # 计算 Adjusted Score
#                 adj_score = 0.4 * C + 0.2 * T + 0.1 * (L + R + TR + TL)
#                 adjusted_scores[row, col] = adj_score
        
#         # 应用特殊规则
#         # 规则1：中间列（第2列，索引2）+5%
#         adjusted_scores[:, 2] += 0.05
        
#         # 规则2：adjusted score > 0.95 的单元格 +5%
#         adjusted_scores[adjusted_scores > 0.95] += 0.05
        
#         # 规则3：如果所有单元格都是 1.00，返回中间
#         if np.all(adjusted_scores >= 0.99):
#             return 2, 'center', 'strong', grid_scores, sidewalk_top_y  # ✅ 返回 sidewalk_top_y
        
#         # 计算每列的总和
#         column_sums = np.sum(adjusted_scores, axis=0)
        
#         # 找到最高分的列
#         best_column = np.argmax(column_sums)
#         best_sum = column_sums[best_column]
        
#         # 判断方向
#         if best_column <= 1:
#             best_direction = 'left'
#         elif best_column >= 3:
#             best_direction = 'right'
#         else:
#             best_direction = 'center'
        
#         # 判断振动强度
#         if best_sum < 0.8:
#             vibration_intensity = 'none'
#         elif adjusted_scores[0, best_column] >= 0.9:  # 顶部单元格
#             vibration_intensity = 'strong'
#         else:
#             vibration_intensity = 'weak'
        
#         return best_column, best_direction, vibration_intensity, grid_scores, sidewalk_top_y  # ✅ 返回 sidewalk_top_y

#     def visualize_analysis(self, frame, best_column, grid_scores, sidewalk_top_y=None):
#         """可视化分析结果（类似 Fig. 6）"""
        
#         if grid_scores is None:
#             return
        
#         # ✅ 使用动态的上边界
#         if sidewalk_top_y is None:
#             sidewalk_top_y = self.analysis_start_y
        
#         # ✅ 绘制动态的上边界线（粗黄线）
#         cv2.line(frame, (0, sidewalk_top_y), (self.frame_width, sidewalk_top_y), 
#                 (0, 255, 255), 3)
        
#         # ✅ 计算动态的单元格高度
#         dynamic_height = self.analysis_end_y - sidewalk_top_y
#         dynamic_cell_height = dynamic_height // self.actual_rows
        
#         # 绘制 2x5 网格
#         for row in range(self.actual_rows):
#             for col in range(self.actual_cols):
#                 # ✅ 计算单元格坐标（使用动态高度）
#                 x_start = col * self.cell_width
#                 y_start = sidewalk_top_y + row * dynamic_cell_height
#                 x_end = x_start + self.cell_width
#                 y_end = y_start + dynamic_cell_height
                
#                 # 绘制边框（黄色）
#                 cv2.rectangle(frame, (x_start, y_start), (x_end, y_end), 
#                             (0, 255, 255), 1)
                
#                 # 获取 raw score（从 3x7 网格，+1 因为有 margin）
#                 raw_score = grid_scores[row + 1, col + 1]
                
#                 # 显示分数（小字体）
#                 text = f"{raw_score:.2f}"
#                 text_size = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)[0]
#                 text_x = x_start + (self.cell_width - text_size[0]) // 2
#                 text_y = y_start + 20
#                 cv2.putText(frame, text, (text_x, text_y),
#                         cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
        
#         # ✅ 高亮最佳列（绿色粗框，从动态上边界开始）
#         if best_column is not None:
#             x_start = best_column * self.cell_width
#             y_start = sidewalk_top_y  # ✅ 使用动态上边界
#             x_end = x_start + self.cell_width
#             y_end = self.analysis_end_y
            
#             cv2.rectangle(frame, (x_start, y_start), (x_end, y_end), 
#                         (0, 255, 0), 3)
            
#             # 标注方向
#             if best_column <= 1:
#                 direction_text = "LEFT"
#             elif best_column >= 3:
#                 direction_text = "RIGHT"
#             else:
#                 direction_text = "CENTER"
            
#             cv2.putText(frame, direction_text, 
#                     (x_start + 10, y_start - 10),
#                     cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)

# ========== ✅ 论文方法：OpenPathAnalyzer 类（完全正确版本）==========
class OpenPathAnalyzer:
    """
    基于论文的 Open Path Mode 实现
    3x7 网格都计算 raw score，只有 2x5 计算 adjusted score
    """
    
    def __init__(self, frame_width, frame_height):
        self.frame_width = frame_width
        self.frame_height = frame_height
        
        # ✅ 完整的 3x7 网格
        self.grid_rows = 3
        self.grid_cols = 7
        
        # 中间的 2x5 决策区域
        self.decision_rows = 2
        self.decision_cols = 5
        
        # ✅ 计算每个单元格的尺寸（基于3x7）
        self.cell_height = frame_height // self.grid_rows
        self.cell_width = frame_width // self.grid_cols
        
        # ✅ 2x5 决策区域在 3x7 中的起始位置
        self.decision_start_row = 1  # 第2行开始
        self.decision_start_col = 1  # 第2列开始
        
        logger.info(f"OpenPathAnalyzer initialized:")
        logger.info(f"  Full grid: 3x7 (all compute raw score)")
        logger.info(f"  Decision area: 2x5 (compute adjusted score)")
        logger.info(f"  Cell size: {self.cell_width}x{self.cell_height}")
    
    def analyze_traversable_area(self, traversable_mask):
        """
        分析可通行区域
        
        Returns:
            best_column: 最佳列索引 (0-4, 相对于2x5)
            best_direction: 'left', 'center', 'right'
            vibration_intensity: 'strong', 'weak', 'none'
            raw_scores: 3x7 的 raw score 矩阵
            adjusted_scores: 2x5 的 adjusted score 矩阵
            sidewalk_top_y: sidewalk最高点
        """
        
        if traversable_mask is None or traversable_mask.sum() == 0:
            return None, None, 'none', None, None, None
        
        # Resize mask 到 frame 尺寸
        mask_resized = cv2.resize(traversable_mask, (self.frame_width, self.frame_height), 
                                interpolation=cv2.INTER_NEAREST)
        
        # ✅ 计算sidewalk的最高点
        sidewalk_pixels = np.where(mask_resized > 0)
        if len(sidewalk_pixels[0]) > 0:
            sidewalk_top_y = int(np.min(sidewalk_pixels[0]))
            # 限制范围
            sidewalk_top_y = max(int(self.frame_height * 0.1), sidewalk_top_y)
            sidewalk_top_y = min(int(self.frame_height * 0.5), sidewalk_top_y)
        else:
            sidewalk_top_y = 0
        
        # ✅ 动态计算单元格高度（从sidewalk顶部到画面底部）
        dynamic_height = self.frame_height - sidewalk_top_y
        dynamic_cell_height = dynamic_height // self.grid_rows
        
        # ✅ 步骤1：计算 3x7 所有格子的 raw score（从sidewalk顶部开始）
        raw_scores = np.zeros((self.grid_rows, self.grid_cols))
        
        for row in range(self.grid_rows):
            for col in range(self.grid_cols):
                # ✅ 计算单元格在画面中的位置（从sidewalk_top_y开始）
                y_start = sidewalk_top_y + row * dynamic_cell_height
                y_end = sidewalk_top_y + (row + 1) * dynamic_cell_height
                x_start = col * self.cell_width
                x_end = (col + 1) * self.cell_width
                
                # 确保不超出画面
                y_end = min(y_end, self.frame_height)
                
                # 提取这个区域的mask
                cell_mask = mask_resized[y_start:y_end, x_start:x_end]
                
                # 计算 raw score
                total_pixels = cell_mask.size
                traversable_pixels = np.sum(cell_mask > 0)
                raw_score = traversable_pixels / total_pixels if total_pixels > 0 else 0
                
                raw_scores[row, col] = raw_score
        
        # ✅ 步骤2：只对中间 2x5 区域计算 adjusted score
        adjusted_scores = np.zeros((self.decision_rows, self.decision_cols))
        
        for row in range(self.decision_rows):
            for col in range(self.decision_cols):
                # 在 3x7 网格中的位置
                i = row + self.decision_start_row  # 1, 2
                j = col + self.decision_start_col  # 1, 2, 3, 4, 5
                
                # 获取邻居（现在可以安全访问，因为有margin）
                C = raw_scores[i, j]        # 当前
                T = raw_scores[i-1, j]      # 上
                L = raw_scores[i, j-1]      # 左
                R = raw_scores[i, j+1]      # 右
                TR = raw_scores[i-1, j+1]   # 右上
                TL = raw_scores[i-1, j-1]   # 左上
                
                # ✅ 论文公式
                adj_score = 0.4 * C + 0.2 * T + 0.1 * (L + R + TR + TL)
                adjusted_scores[row, col] = adj_score
        
        # ✅ 步骤3：应用特殊规则
        # 规则1：中间列 +5%
        center_col = 2  # 2x5中的第3列
        adjusted_scores[:, center_col] += 0.05
        
        # 规则2：adjusted score > 0.95 的 +5%
        adjusted_scores[adjusted_scores > 0.95] += 0.05
        
        # 规则3：如果全是高分，返回中间
        if np.all(adjusted_scores >= 0.99):
            return center_col, 'center', 'strong', raw_scores, adjusted_scores, sidewalk_top_y
        
        # ✅ 步骤4：选择最佳列
        column_sums = np.sum(adjusted_scores, axis=0)
        best_column = np.argmax(column_sums)
        best_sum = column_sums[best_column]
        
        # 判断方向
        if best_column <= 1:
            best_direction = 'left'
        elif best_column >= 3:
            best_direction = 'right'
        else:
            best_direction = 'center'
        
        # 判断振动强度
        if best_sum < 0.8:
            vibration_intensity = 'none'
        elif adjusted_scores[0, best_column] >= 0.9:
            vibration_intensity = 'strong'
        else:
            vibration_intensity = 'weak'
        
        return best_column, best_direction, vibration_intensity, raw_scores, adjusted_scores, sidewalk_top_y

    def visualize_analysis(self, frame, best_column, raw_scores, adjusted_scores, sidewalk_top_y=None):
        """可视化分析结果（完全按照论文 Fig. 6）"""
        
        if raw_scores is None:
            return
        
        # ✅ 使用动态的起始位置
        if sidewalk_top_y is None:
            sidewalk_top_y = 0
        
        # ✅ 计算动态单元格高度
        dynamic_height = self.frame_height - sidewalk_top_y
        dynamic_cell_height = dynamic_height // self.grid_rows
        
        # ✅ 绘制 sidewalk 顶部线（这就是3x7网格的顶部）
        cv2.line(frame, (0, sidewalk_top_y), (self.frame_width, sidewalk_top_y), 
                (0, 255, 255), 3)
        
        # ✅ 绘制 3x7 完整网格（从sidewalk顶部开始）
        for row in range(self.grid_rows):
            for col in range(self.grid_cols):
                # ✅ 计算单元格坐标（从sidewalk_top_y开始）
                x_start = col * self.cell_width
                y_start = sidewalk_top_y + row * dynamic_cell_height
                x_end = x_start + self.cell_width
                y_end = sidewalk_top_y + (row + 1) * dynamic_cell_height
                
                # 确保不超出画面
                y_end = min(y_end, self.frame_height)
                
                # ✅ 判断是否在 2x5 决策区域
                in_decision_area = (row >= self.decision_start_row and 
                                row < self.decision_start_row + self.decision_rows and
                                col >= self.decision_start_col and 
                                col < self.decision_start_col + self.decision_cols)
                
                # 绘制边框
                if in_decision_area:
                    border_color = (0, 165, 255)  # 橙色（2x5区域）
                    border_thickness = 2
                else:
                    border_color = (100, 100, 100)  # 灰色（margin区域）
                    border_thickness = 1
                
                cv2.rectangle(frame, (x_start, y_start), (x_end, y_end), 
                            border_color, border_thickness)
                
                # ✅ 显示 Raw Score（上方，大字）
                raw_score = raw_scores[row, col]
                raw_text = f"{raw_score:.2f}"
                text_size = cv2.getTextSize(raw_text, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)[0]
                text_x = x_start + (self.cell_width - text_size[0]) // 2
                text_y = y_start + 25
                
                # 确保文字不超出画面
                if text_y < self.frame_height:
                    cv2.putText(frame, raw_text, (text_x, text_y),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 100, 0), 2)
                
                # ✅ 显示 Adjusted Score（下方，小字，仅2x5区域）
                if in_decision_area:
                    decision_row = row - self.decision_start_row
                    decision_col = col - self.decision_start_col
                    adj_score = adjusted_scores[decision_row, decision_col]
                    adj_text = f"{adj_score:.2f}"
                    text_size = cv2.getTextSize(adj_text, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)[0]
                    text_x = x_start + (self.cell_width - text_size[0]) // 2
                    text_y = y_start + 50
                    
                    # 确保文字不超出画面
                    if text_y < self.frame_height:
                        cv2.putText(frame, adj_text, (text_x, text_y),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 0), 1)
        
        # ✅ 高亮最佳列（绿色填充，半透明，从sidewalk顶部开始）
        if best_column is not None:
            col_3x7 = best_column + self.decision_start_col
            x_start = col_3x7 * self.cell_width
            y_start = sidewalk_top_y  # ✅ 从网格顶部开始
            x_end = x_start + self.cell_width
            y_end = self.frame_height
            
            # 创建半透明绿色遮罩
            overlay = frame.copy()
            cv2.rectangle(overlay, (x_start, y_start), (x_end, y_end), 
                        (0, 255, 0), -1)
            cv2.addWeighted(overlay, 0.3, frame, 0.7, 0, frame)
            
            # 绘制边框
            cv2.rectangle(frame, (x_start, y_start), (x_end, y_end), 
                        (0, 255, 0), 3)
            
            # 标注方向
            if best_column <= 1:
                direction_text = "LEFT"
            elif best_column >= 3:
                direction_text = "RIGHT"
            else:
                direction_text = "CENTER"
            
            # 文字位置
            text_y = y_start + 30 if y_start > 30 else 30
            cv2.putText(frame, direction_text, 
                    (x_start + 10, text_y),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
            
    def get_haptic_signal(self, best_column, vibration_intensity):
        """
        Generate haptic feedback signal for the belt
        
        Args:
            best_column: Best column index (0-4)
            vibration_intensity: 'strong', 'weak', or 'none'
        
        Returns:
            tuple: (column_index, top_intensity, bottom_intensity)
                or None if no vibration needed
        """
        if best_column is None or vibration_intensity == 'none':
            return None
        
        # ✅ 修改：映射到 0-5 范围（硬件支持）
        if vibration_intensity == 'strong':
            # Strong: both motors vibrate at high intensity
            top_intensity = 5
            bottom_intensity = 5
        elif vibration_intensity == 'weak':
            # Weak: only bottom motor vibrates at medium intensity
            top_intensity = 0
            bottom_intensity = 3
        else:
            return None
        
        return (best_column, top_intensity, bottom_intensity)

# ========== BeepThread 类 ==========
class BeepThread(threading.Thread):
    def __init__(self):
        super().__init__()
        self.distance = None
        self.running = True
        self.update_interval = 0.01
        self.object_color = None
        
        self.base_sound_config = {
            1: {
                'note': 72,
                'duration': 0.15,
                'distance_min': 150,
                'distance_max': 280,
                'delay_min': 0.2,
                'delay_max': 0.6,
                'velocity_min': 80,
                'velocity_max': 127,
            },
            2: {
                'note': 60,
                'duration': 0.15,
                'distance_min': 280,
                'distance_max': 520,
                'delay_min': 0.25,
                'delay_max': 1.5,
                'velocity_min': 50,
                'velocity_max': 100,
            },
        }
        
        self.beeping_pan_x = 0.5
        self.current_delay = 0.5
        self.current_velocity = 100
        
        try:
            logger.info("Initializing FluidSynth...")
            self.fs = fluidsynth.Synth()
            self.fs.setting('synth.audio-channels', 2)
            self.fs.setting('synth.gain', 0.3)
            
            audio_driver = None
            for driver in ['pulseaudio', 'alsa', 'sdl2', 'oss']:
                try:
                    self.fs.start(driver=driver)
                    audio_driver = driver
                    logger.info(f"FluidSynth started with {driver} driver")
                    break
                except Exception as e:
                    logger.debug(f"Failed to start {driver}: {e}")
            
            if audio_driver is None:
                raise RuntimeError("Could not start any audio driver")
            
            soundfont_paths = [
                "/usr/share/sounds/sf2/FluidR3_GM.sf2",
                "/usr/share/soundfonts/FluidR3_GM.sf2",
                "/usr/share/sounds/sf2/default.sf2",
                os.path.expanduser("~/soundfonts/FluidR3Mono_GM.sf3"),
                "./soundfonts/FluidR3Mono_GM.sf3",
            ]
            
            sfid = -1
            for path in soundfont_paths:
                if os.path.exists(path):
                    try:
                        sfid = self.fs.sfload(path)
                        if sfid != -1:
                            logger.info(f"Successfully loaded SoundFont: {path}")
                            break
                    except Exception as e:
                        logger.warning(f"Failed to load {path}: {e}")
            
            if sfid == -1:
                raise RuntimeError("Could not load any SoundFont")
            
            self.fs.program_select(0, sfid, 0, 80)
            logger.info("FluidSynth initialized successfully")
            self.fluidsynth_enabled = True
            
        except Exception as e:
            logger.error(f"FluidSynth initialization failed: {e}")
            self.fluidsynth_enabled = False
            self.processes = []
        
        self.last_beep_time = 0

    def calculate_dynamic_params(self, distance, object_color):
        if object_color not in self.base_sound_config:
            return 0.5, 100
        
        config = self.base_sound_config[object_color]
        clamped_distance = max(config['distance_min'], min(distance, config['distance_max']))
        
        distance_ratio = (clamped_distance - config['distance_min']) / \
                        (config['distance_max'] - config['distance_min'])
        distance_ratio_curved = distance_ratio ** 1.5
        
        dynamic_delay = config['delay_min'] + \
                       (config['delay_max'] - config['delay_min']) * distance_ratio_curved
        
        dynamic_velocity = config['velocity_max'] - \
                          (config['velocity_max'] - config['velocity_min']) * distance_ratio_curved
        
        return dynamic_delay, int(dynamic_velocity)

    def beep(self, note, velocity, duration, delay, beeping_pan_x):
        try:
            if self.fluidsynth_enabled:
                pan_value = int(beeping_pan_x * 127)
                self.fs.cc(0, 10, pan_value)
                self.fs.noteon(0, note, velocity)
                time.sleep(duration)
                self.fs.noteoff(0, note)
            
            time.sleep(delay - duration)
                    
        except Exception as e:
            logger.error(f"Error in beep: {e}")

    def run(self):
        while self.running:
            if self.object_color in self.base_sound_config and self.distance is not None:
                config = self.base_sound_config[self.object_color]
                self.beep(
                    config['note'],
                    self.current_velocity,
                    config['duration'],
                    self.current_delay,
                    self.beeping_pan_x
                )
            else:
                time.sleep(0.1)
            time.sleep(self.update_interval)

    def update_distance(self, new_distance, new_color=None, beeping_pan_x=None):
        self.distance = new_distance
        self.object_color = new_color
        self.beeping_pan_x = beeping_pan_x if beeping_pan_x is not None else 0.5
        
        if new_distance is not None and new_color is not None:
            self.current_delay, self.current_velocity = self.calculate_dynamic_params(
                new_distance, new_color
            )

    def stop(self):
        self.running = False
        if hasattr(self, 'fluidsynth_enabled') and self.fluidsynth_enabled:
            try:
                self.fs.delete()
            except:
                pass

# ========== CurbGuidanceTracker 类（增强版）==========
class CurbGuidanceTracker:
    def __init__(self, stability_frames=3, cooldown_seconds=2, angle_tolerance=15):  # ✅ 改为3帧
        self.stability_frames = stability_frames
        self.cooldown_seconds = cooldown_seconds
        self.angle_tolerance = angle_tolerance
        
        # Curb down 追踪
        self.curb_down_history = deque(maxlen=stability_frames)
        self.curb_down_angle_history = deque(maxlen=stability_frames)
        self.curb_down_in_fan_history = deque(maxlen=stability_frames)
        self.curb_down_stable_state = False
        self.curb_down_stable_in_fan = False
        self.curb_down_disappeared_time = 0
        self.last_curb_down_guidance_time = 0
        
        # Curb up 追踪
        self.curb_up_history = deque(maxlen=stability_frames)
        self.curb_up_angle_history = deque(maxlen=stability_frames)
        self.curb_up_in_fan_history = deque(maxlen=stability_frames)
        self.curb_up_stable_state = False
        self.curb_up_stable_in_fan = False
        self.curb_up_disappeared_time = 0
        self.last_curb_up_guidance_time = 0
        
        # Open path 追踪
        self.open_path_history = deque(maxlen=stability_frames)
        self.open_path_stable_state = False
        self.last_open_path_guidance_time = 0
        self.open_path_cooldown = 4  # ✅ 改为4秒
        
        # ✅ Sidewalk direction 追踪（简化版）
        self.sidewalk_best_direction_history = deque(maxlen=stability_frames)
        self.last_sidewalk_guidance_time = 0
        self.sidewalk_guidance_cooldown = 4  # ✅ 改为4秒
        
        self.logger = logging.getLogger(__name__)
    
    def update(self, curb_down_detected, curb_down_angle, curb_down_in_fan,
               curb_up_detected, curb_up_angle, curb_up_in_fan, current_time,
               road_area=0, sidewalk_area=0,
               sidewalk_best_direction=None):  # ✅ 只接收方向
        
        should_interrupt_down = False
        should_interrupt_up = False
        
        # === Curb down 处理 ===
        self.curb_down_history.append(curb_down_detected)
        self.curb_down_angle_history.append(curb_down_angle if curb_down_detected else None)
        self.curb_down_in_fan_history.append(curb_down_in_fan)
        
        if len(self.curb_down_history) == self.stability_frames:
            down_detected_count = sum(self.curb_down_history)
            down_in_fan_count = sum(self.curb_down_in_fan_history)
            new_stable_down = down_detected_count >= (self.stability_frames * 0.4)
            new_stable_in_fan_down = down_in_fan_count >= (self.stability_frames * 0.4)
            
            if self.curb_down_stable_state and not new_stable_down:
                not_detected_count = self.stability_frames - down_detected_count
                if not_detected_count >= (self.stability_frames * 0.6):
                    should_interrupt_down = True
                    self.curb_down_disappeared_time = current_time
            
            elif self.curb_down_stable_in_fan and not new_stable_in_fan_down:
                not_in_fan_count = self.stability_frames - down_in_fan_count
                if not_in_fan_count >= (self.stability_frames * 0.6):
                    should_interrupt_down = True
            
            self.curb_down_stable_state = new_stable_down
            self.curb_down_stable_in_fan = new_stable_in_fan_down
        
        # === Curb up 处理 ===
        self.curb_up_history.append(curb_up_detected)
        self.curb_up_angle_history.append(curb_up_angle if curb_up_detected else None)
        self.curb_up_in_fan_history.append(curb_up_in_fan)
        
        if len(self.curb_up_history) == self.stability_frames:
            up_detected_count = sum(self.curb_up_history)
            up_in_fan_count = sum(self.curb_up_in_fan_history)
            new_stable_up = up_detected_count >= (self.stability_frames * 0.4)
            new_stable_in_fan_up = up_in_fan_count >= (self.stability_frames * 0.4)
            
            if self.curb_up_stable_state and not new_stable_up:
                not_detected_count = self.stability_frames - up_detected_count
                if not_detected_count >= (self.stability_frames * 0.6):
                    should_interrupt_up = True
                    self.curb_up_disappeared_time = current_time
            
            elif self.curb_up_stable_in_fan and not new_stable_in_fan_up:
                not_in_fan_count = self.stability_frames - up_in_fan_count
                if not_in_fan_count >= (self.stability_frames * 0.6):
                    should_interrupt_up = True
            
            self.curb_up_stable_state = new_stable_up
            self.curb_up_stable_in_fan = new_stable_in_fan_up
        
        # === Open path 处理 ===
        no_curb_in_fan = not (curb_down_in_fan or curb_up_in_fan)
        # ✅ 去掉 sufficient_traversable_area 条件，只要扇形区域内无curb即可
        
        open_path_detected = no_curb_in_fan
        
        self.open_path_history.append(open_path_detected)
        
        if len(self.open_path_history) == self.stability_frames:
            open_path_count = sum(self.open_path_history)
            new_stable_open_path = open_path_count >= (self.stability_frames * 0.7)  # 3帧中至少2帧
            self.open_path_stable_state = new_stable_open_path
        
        # ✅ === Sidewalk direction 处理（简化版）===
        self.sidewalk_best_direction_history.append(sidewalk_best_direction)
        
        # 不再追踪 has_obstacle，只追踪方向是否稳定
        
        return should_interrupt_down, should_interrupt_up
    
    def get_stable_angle(self, curb_type):
        if curb_type == "curb_down":
            angles = [a for a in self.curb_down_angle_history if a is not None]
        elif curb_type == "curb_up":
            angles = [a for a in self.curb_up_angle_history if a is not None]
        else:
            return None
        
        if len(angles) < self.stability_frames * 0.6:
            return None
        
        stable_angle = np.median(angles)
        angle_std = np.std(angles)
        if angle_std > self.angle_tolerance:
            return None
        
        return stable_angle
    
    def should_guide(self, curb_type, current_time, guidance_interval):
        if curb_type == "curb_down":
            time_since_disappeared = current_time - self.curb_down_disappeared_time
            time_since_last_guidance = current_time - self.last_curb_down_guidance_time
        elif curb_type == "curb_up":
            time_since_disappeared = current_time - self.curb_up_disappeared_time
            time_since_last_guidance = current_time - self.last_curb_up_guidance_time
        else:
            return False, None
        
        if time_since_disappeared < self.cooldown_seconds:
            return False, None
        
        if time_since_last_guidance < guidance_interval:
            return False, None
        
        stable_angle = self.get_stable_angle(curb_type)
        if stable_angle is None:
            return False, None
        
        return True, stable_angle
    
    def mark_guidance_given(self, curb_type, current_time):
        if curb_type == "curb_down":
            self.last_curb_down_guidance_time = current_time
        elif curb_type == "curb_up":
            self.last_curb_up_guidance_time = current_time
    
    def should_guide_open_path(self, current_time):
        time_since_last = current_time - self.last_open_path_guidance_time
        
        if time_since_last < self.open_path_cooldown:
            return False
        
        return self.open_path_stable_state
    
    def mark_open_path_guidance_given(self, current_time):
        self.last_open_path_guidance_time = current_time
    
    # ✅ Sidewalk direction 相关方法（简化版）
    def should_guide_sidewalk_direction(self, current_time):
        """判断是否应该给出sidewalk方向引导"""
        time_since_last = current_time - self.last_sidewalk_guidance_time
        
        if time_since_last < self.sidewalk_guidance_cooldown:
            return False, None
        
        # ✅ 获取稳定的最佳方向（最近3帧中至少1帧，即34%）
        directions = [d for d in self.sidewalk_best_direction_history if d is not None]
        if len(directions) < self.stability_frames * 0.34:  # ✅ 改为34%（3帧中1帧）
            return False, None
        
        # 找出出现次数最多的方向
        from collections import Counter
        direction_counts = Counter(directions)
        stable_direction = direction_counts.most_common(1)[0][0]
        
        # ✅ 只要方向稳定就返回True
        return True, stable_direction
    
    def mark_sidewalk_guidance_given(self, current_time):
        """标记已给出sidewalk引导"""
        self.last_sidewalk_guidance_time = current_time

# ========== FanZoneConfig 类 ==========
class FanZoneConfig:
    def __init__(self, frame_width, frame_height):
        self.frame_width = frame_width
        self.frame_height = frame_height
        
        self.center_x = frame_width // 2
        self.center_y = frame_height + int(frame_height * 0.3)
        self.center = (self.center_x, self.center_y)
        
        self.start_circle = int(frame_height * 0.83)
        self.circle_distance = int(frame_height * 0.19)
        
        self.axes_lengths = [
            (self.start_circle - int(frame_height * 0.31), 
             self.start_circle + int(frame_height * 0.02)),
            (self.start_circle + self.circle_distance - int(frame_height * 0.27), 
             self.start_circle + self.circle_distance)
        ]
        
        self.start_angle = -130
        self.end_angle = -50
        self.mid_left_angle = -110
        self.mid_right_angle = -70
        
        self.start_angles = (-135, -130)
        self.end_angles = (-45, -50)
        self.fan_colors = [(0, 0, 255), (0, 255, 255)]
        
        logger.info(f"FanZone: {frame_width}x{frame_height}, Center: {self.center}")

# ========== FanZoneDetector 类 ==========
class FanZoneDetector:
    def __init__(self, center, red_axes, yellow_axes, start_angle, end_angle, 
                 mid_left_angle, mid_right_angle, device, frame_height=None):
        self.center = torch.tensor(center, dtype=torch.float32, device=device)
        self.axes_lengths = [red_axes, yellow_axes]
        self.start_angle = start_angle
        self.end_angle = end_angle
        self.mid_left_angle = mid_left_angle
        self.mid_right_angle = mid_right_angle
        self.device = device
        self.frame_height = frame_height if frame_height else 480

    def calculate_line(self, x_radius, y_radius, angle_degrees):
        angle_radians = math.radians(angle_degrees)
        x = self.center[0] + x_radius * math.cos(angle_radians)
        y = self.center[1] + y_radius * math.sin(angle_radians)
        return int(x), int(y)

    def classify_points(self, points):
        points_tensor = torch.tensor(points, dtype=torch.float32, device=self.device)
        displacement = points_tensor - self.center
        distances = torch.norm(displacement, dim=1)
        normalized_distances = distances * (480.0 / self.frame_height)
        
        angles = torch.atan2(displacement[:, 1], displacement[:, 0]) * (180 / np.pi)
        angles = (angles + 360) % 360 - 360
        classifications = torch.full((points_tensor.shape[0],), -1, dtype=torch.int, device=self.device)
        
        valid_points = None
        for i, (a, b) in enumerate(reversed(self.axes_lengths)):
            within_ellipse = ((displacement[:, 0] ** 2) / (a ** 2) + (displacement[:, 1] ** 2) / (b ** 2)) <= 1
            within_angle = (angles >= self.start_angle) & (angles <= self.end_angle)
            if i == 0:
                valid_points = within_ellipse & within_angle
            mid_left = (angles >= self.start_angle) & (angles < self.mid_left_angle)
            mid_right = (angles > self.mid_right_angle) & (angles <= self.end_angle)
            mid = (angles < self.mid_right_angle) & (angles > self.mid_left_angle)
            classifications[within_ellipse & mid_left] = 3 - 3 * i
            classifications[within_ellipse & mid] = 4 - 3 * i
            classifications[within_ellipse & mid_right] = 5 - 3 * i
        
        has_points_in_fan = valid_points.any() if valid_points is not None else False
        
        if has_points_in_fan:
            valid_distances = normalized_distances[valid_points]
            min_distance, min_idx_relative = torch.min(valid_distances, 0)
            valid_indices = torch.nonzero(valid_points, as_tuple=True)[0]
            min_idx = valid_indices[min_idx_relative]
            min_x_value = points[min_idx, 0].item()
            closest_zone_classification = classifications[min_idx]
            return classifications.cpu().numpy(), min_distance, closest_zone_classification, min_x_value, True
        else:
            return classifications.cpu().numpy(), None, None, None, False

# ========== 初始化扇形区域 ==========
fan_config = FanZoneConfig(frame_width, frame_height)

fan_detector = FanZoneDetector(
    fan_config.center,
    fan_config.axes_lengths[0],
    fan_config.axes_lengths[1],
    fan_config.start_angle,
    fan_config.end_angle,
    fan_config.mid_left_angle,
    fan_config.mid_right_angle,
    device=device,
    frame_height=frame_height
)

left_line = fan_detector.calculate_line(fan_config.axes_lengths[-1][0], fan_config.axes_lengths[-1][1], fan_config.start_angle)
right_line = fan_detector.calculate_line(fan_config.axes_lengths[-1][0], fan_config.axes_lengths[-1][1], fan_config.end_angle)
mid_left_line = fan_detector.calculate_line(fan_config.axes_lengths[-1][0], fan_config.axes_lengths[-1][1], fan_config.mid_left_angle)
mid_right_line = fan_detector.calculate_line(fan_config.axes_lengths[-1][0], fan_config.axes_lengths[-1][1], fan_config.mid_right_angle)

# ✅ 初始化 SidewalkAnalyzer
sidewalk_analyzer = SidewalkAnalyzer(frame_width, frame_height)

open_path_analyzer = OpenPathAnalyzer(frame_width, frame_height)

# ========== 启动线程 ==========
beep_thread = BeepThread()
beep_thread.daemon = True
beep_thread.start()

mimic3_tts_thread = CompletePrerecordedAudio(
    audio_dir="audio_prerecorded_complete",
    logger=logger,
    delay=4
)
mimic3_tts_thread.daemon = True
mimic3_tts_thread.start()
mimic3_tts_thread.ready_event.wait()

mimic3_tts_thread.enqueue_phrase("starting")

curb_tracker = CurbGuidanceTracker(
    stability_frames=3,  # ✅ 改为3帧
    cooldown_seconds=2,
    angle_tolerance=15
)

keyboard_thread = KeyboardListener()
keyboard_thread.start()

confidence_threshold = 0.4
FOV_DEGREES = 60
ANGLE_THRESHOLD = 10
GUIDANCE_INTERVAL = 4

logger.info("="*60)
logger.info("🎬 STARTING MAIN LOOP")
logger.info("="*60)

# ========== 主循环 ==========
prev_frame_time = 0
frame_count = 0

# ========== 帧计数器：统计每个class出现的帧数 ==========
# class 0: curb_down, 1: curb_up, 2: road, 3: sidewalk
class_frame_counts = {0: 0, 1: 0, 2: 0, 3: 0}

try:
    logger.info("Initializing MQTT Haptic Controller...")
    haptic_controller = HapticMQTTController(
        broker_address="localhost",
        broker_port=1883,
        topic="esp32/output",
        publish_interval=0.1
    )
    
    if haptic_controller.connect():
        haptic_controller.start()
        haptic_controller.ready_event.wait(timeout=5)
        
        if haptic_controller.connected:
            logger.info("✅ MQTT Haptic Controller ready")
            HAPTIC_ENABLED = True
        else:
            logger.warning("⚠️  MQTT not connected, haptic feedback disabled")
            HAPTIC_ENABLED = False
    else:
        logger.warning("⚠️  Failed to connect to MQTT broker, haptic feedback disabled")
        HAPTIC_ENABLED = False

except Exception as e:
    logger.error(f"❌ Failed to initialize haptic controller: {e}")
    HAPTIC_ENABLED = False

try:
    while not exit_flag.is_set():
        # ===== 1. 读取帧 =====
        with profile_code_block("01_帧捕获"):
            success, frame = cap.read()
            if not success:
                if VIDEO_TEST_MODE:
                    logger.info("📹 Video ended, looping...")
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    continue
                else:
                    logger.warning("Failed to read frame")
                    continue
        
        # ===== 2. 鱼眼校正 =====
        with profile_code_block("02_鱼眼校正"):
            if fisheye_enabled and map1 is not None:
                dst = cv2.remap(frame, map1, map2, interpolation=cv2.INTER_LINEAR)
            else:
                dst = frame
            
            new_frame_time = time.time()
        
        # ===== 3. YOLO推理 =====
        with profile_code_block("03_YOLO推理"):
            results = model(dst, stream=True, verbose=False)
        
        # ===== 4. 初始化检测结果 =====
        curb_down_detected = False
        curb_down_angle = None
        curb_down_points = None
        curb_down_in_fan = False
        
        curb_up_detected = False
        curb_up_angle = None
        curb_up_points = None
        curb_up_in_fan = False
        
        road_area = 0
        sidewalk_area = 0
        total_area = frame_height * frame_width
        
        # ✅ Sidewalk分析结果
        sidewalk_mask = None
        sidewalk_left_density = 0
        sidewalk_center_density = 0
        sidewalk_right_density = 0
        sidewalk_best_direction = None
        
        # ========== 本帧检测到的class集合（用于帧计数）==========
        classes_in_this_frame = set()
        
        text_y_offset = 50
        
        lowest_curb_down_index = None
        lowest_curb_up_index = None
        result_boxes = None
        result_masks = None
        result_confidences = None
        result_classes = None
        
        # ===== 5. 处理YOLO结果 =====
        with profile_code_block("04_YOLO结果处理"):
            for result in results:
                if result.masks is not None:
                    result_boxes = result.boxes.xyxy.cpu().numpy()
                    result_masks = result.masks.data.cpu().numpy()
                    result_confidences = result.boxes.conf.cpu().numpy()
                    result_classes = result.boxes.cls.cpu().numpy()

                    # 绘制检测结果（只绘制curb的mask）
                    for i, (box, cls, conf) in enumerate(zip(result_boxes, result_classes, result_confidences)):
                        if conf >= confidence_threshold:
                            class_name = classNames[int(cls)]
                            
                            
                            mask = result_masks[i]
                            mask_np = (mask * 255).astype(np.uint8)
                            mask_resized = cv2.resize(mask_np, (frame_width, frame_height), 
                                                        interpolation=cv2.INTER_NEAREST)
                            mask_bool = mask_resized.astype(bool)
                            color = class_colors[int(cls)]
                            color_overlay = np.array(color)
                            dst[mask_bool] = dst[mask_bool] * 0.7 + color_overlay * 0.3
                            
                            cv2.putText(dst, f"{class_name}: {conf:.2f}", (10, text_y_offset), 
                                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
                            text_y_offset += 30
                    
                    lowest_curb_down_y2 = -1
                    lowest_curb_up_y2 = -1
                    
                    for i, (box, cls) in enumerate(zip(result_boxes, result_classes)):
                        if result_confidences[i] >= confidence_threshold:
                            x1, y1, x2, y2 = box
                            if cls == 0:
                                if y2 > lowest_curb_down_y2:
                                    lowest_curb_down_y2 = y2
                                    lowest_curb_down_index = i
                            elif cls == 1:
                                if y2 > lowest_curb_up_y2:
                                    lowest_curb_up_y2 = y2
                                    lowest_curb_up_index = i
                    
                    # 计算面积并获取sidewalk mask
                    for i, cls in enumerate(result_classes):
                        if result_confidences[i] >= confidence_threshold:
                            classes_in_this_frame.add(int(cls))  # ✅ 记录本帧出现的class
                            mask = result_masks[i]
                            if VIDEO_TEST_MODE:
                                mask_resized = cv2.resize(mask, (frame_width, frame_height), interpolation=cv2.INTER_NEAREST)
                            
                            if cls == 2:  # road
                                if VIDEO_TEST_MODE:
                                    road_area += np.sum(mask_resized > 0)
                                else:
                                    road_area += np.sum(mask)
                            elif cls == 3:  # sidewalk
                                if VIDEO_TEST_MODE:
                                    sidewalk_area += np.sum(mask_resized > 0)  # ✅ 用resize后的
                
                                    # ✅ 保存resize后的mask
                                    if sidewalk_mask is None:
                                        sidewalk_mask = mask_resized  # ✅ 改为保存resize后的
                                    else:
                                        sidewalk_mask = np.maximum(sidewalk_mask, mask_resized)
                                else:
                                    sidewalk_area += np.sum(mask)
                                    # ✅ 保存sidewalk mask用于分析
                                    if sidewalk_mask is None:
                                        sidewalk_mask = mask
                                    else:
                                        sidewalk_mask = np.maximum(sidewalk_mask, mask)
                                    
        
        sidewalk_area /= total_area
        road_area /= total_area

        # ========== 更新class帧计数器 ==========
        for cls_id in classes_in_this_frame:
            if cls_id in class_frame_counts:
                class_frame_counts[cls_id] += 1

        if frame_count % 30 == 0:
            logger.info(f"📊 Area calculation:")
            logger.info(f"   Total area: {total_area}")
            logger.info(f"   Sidewalk %: {sidewalk_area:.4f} ({sidewalk_area*100:.2f}%)")
            logger.info(f"   Road %: {road_area:.4f} ({road_area*100:.2f}%)")
        
        # ✅ ===== 6. 分析sidewalk完整性 =====
        # with profile_code_block("05_sidewalk_analysis"):
        #     if sidewalk_mask is not None and sidewalk_area > 0.2:  # 至少20%是sidewalk
        #         (sidewalk_left_density, 
        #         sidewalk_center_density, 
        #         sidewalk_right_density, 
        #         sidewalk_best_direction,
        #         sidewalk_top_y) = sidewalk_analyzer.analyze_sidewalk_mask(sidewalk_mask)
                
        #         # ✅ 添加调试日志（每30帧输出一次）
        #         if frame_count % 30 == 0:
        #             logger.info(f"🔍 SW Analysis - L:{sidewalk_left_density:.2f} C:{sidewalk_center_density:.2f} R:{sidewalk_right_density:.2f}")
        #             logger.info(f"   Best direction: {sidewalk_best_direction}")
                
        #         # 可视化分析结果
        #         sidewalk_analyzer.visualize_analysis(
        #             dst, 
        #             sidewalk_left_density, 
        #             sidewalk_center_density, 
        #             sidewalk_right_density, 
        #             sidewalk_best_direction,
        #             sidewalk_top_y  # ✅ 传入动态上边界
        #         )

        # with profile_code_block("05_open_path_analysis"):
        #     best_column = None
        #     best_direction = None
        #     vibration_intensity = 'none'
        #     grid_scores = None
        #     sidewalk_top_y = None  # ✅ 添加这个变量
            
        #     if sidewalk_mask is not None and sidewalk_area > 0.05:
        #         # ✅ 接收 sidewalk_top_y
        #         best_column, best_direction, vibration_intensity, grid_scores, sidewalk_top_y = \
        #             open_path_analyzer.analyze_traversable_area(sidewalk_mask)
                
        #         # ✅ 调试日志（每30帧）
        #         if frame_count % 30 == 0 and best_direction is not None:
        #             logger.info(f"🎯 Open Path Analysis:")
        #             logger.info(f"   Best column: {best_column}, Direction: {best_direction}")
        #             logger.info(f"   Vibration: {vibration_intensity}")
        #             logger.info(f"   Sidewalk top Y: {sidewalk_top_y}")
                
        #         # ✅ 传入 sidewalk_top_y 进行可视化
        #         open_path_analyzer.visualize_analysis(frame, best_column, grid_scores, sidewalk_top_y)

        with profile_code_block("05_open_path_analysis"):
            best_column = None
            best_direction = None
            vibration_intensity = 'none'
            raw_scores = None
            adjusted_scores = None
            sidewalk_top_y = None
            
            if sidewalk_mask is not None and sidewalk_area > 0.05:
                # ✅ 接收所有返回值
                best_column, best_direction, vibration_intensity, raw_scores, adjusted_scores, sidewalk_top_y = \
                    open_path_analyzer.analyze_traversable_area(sidewalk_mask)
                
                # 调试日志
                if frame_count % 30 == 0 and best_direction is not None:
                    logger.info(f"🎯 Open Path Analysis:")
                    logger.info(f"   Best column: {best_column}, Direction: {best_direction}")
                    logger.info(f"   Vibration: {vibration_intensity}")
                    logger.info(f"   Sidewalk top Y: {sidewalk_top_y}")
                
                # ✅ 可视化（显示3x7网格）
                open_path_analyzer.visualize_analysis(frame, best_column, raw_scores, adjusted_scores, sidewalk_top_y)
                if HAPTIC_ENABLED and not (curb_down_in_fan or curb_up_in_fan):
                    # 只有在curb不在扇形区域内时才触发Open Path振动
                    haptic_signal = open_path_analyzer.get_haptic_signal(best_column, vibration_intensity)
                    
                    if haptic_signal is not None:
                        col_idx, top_intensity, bottom_intensity = haptic_signal
                        haptic_controller.set_column_vibration(col_idx, top_intensity, bottom_intensity)
                        
                        if frame_count % 30 == 0:
                            logger.info(f"🎮 Haptic: Column {col_idx}, Top={top_intensity}, Bottom={bottom_intensity}")
                    else:
                        # No vibration needed
                        haptic_controller.clear_all()
                else:
                    # Curb has priority, clear open path vibrations
                    if HAPTIC_ENABLED:
                        haptic_controller.clear_all()

        
        # ===== 7. 处理curb_down =====
        with profile_code_block("06_curb_down处理"):
            if lowest_curb_down_index is not None and result_masks is not None:
                curb_down_detected = True
                curb_down_mask = result_masks[lowest_curb_down_index]
                curb_down_mask_np = (curb_down_mask * 255).astype(np.uint8)
                curb_down_mask_resized = cv2.resize(curb_down_mask_np, (frame_width, frame_height), 
                                                    interpolation=cv2.INTER_NEAREST)
                
                y_vals, x_vals = np.where(curb_down_mask_resized != 0)
                if y_vals.size > 0:
                    df = pd.DataFrame({'x': x_vals, 'y': y_vals})
                    curb_down_points = df.groupby('x')['y'].max().reset_index().values
                    
                    x_vals = curb_down_points[:, 0]
                    y_vals = curb_down_points[:, 1]
                    gradients = np.gradient(y_vals, x_vals)
                    average_gradient = np.mean(gradients)
                    angle_radians = np.arctan(average_gradient)
                    curb_down_angle = -int(np.degrees(angle_radians))
                    
                    _, _, _, _, curb_down_in_fan = fan_detector.classify_points(curb_down_points)
        
        # ===== 8. 处理curb_up =====
        with profile_code_block("07_curb_up处理"):
            if lowest_curb_up_index is not None and result_masks is not None:
                curb_up_detected = True
                curb_up_mask = result_masks[lowest_curb_up_index]
                curb_up_mask_np = (curb_up_mask * 255).astype(np.uint8)
                curb_up_mask_resized = cv2.resize(curb_up_mask_np, (frame_width, frame_height), 
                                                  interpolation=cv2.INTER_NEAREST)
                
                y_vals, x_vals = np.where(curb_up_mask_resized != 0)
                if y_vals.size > 0:
                    df = pd.DataFrame({'x': x_vals, 'y': y_vals})
                    curb_up_points = df.groupby('x')['y'].max().reset_index().values
                    
                    x_vals = curb_up_points[:, 0]
                    y_vals = curb_up_points[:, 1]
                    gradients = np.gradient(y_vals, x_vals)
                    average_gradient = np.mean(gradients)
                    angle_radians = np.arctan(average_gradient)
                    curb_up_angle = -int(np.degrees(angle_radians))
                    
                    _, _, _, _, curb_up_in_fan = fan_detector.classify_points(curb_up_points)
        
        # ✅ ===== 9. 更新追踪器（传入sidewalk分析结果）=====
        with profile_code_block("08_Curb追踪"):
            current_time = time.time()
            
            should_interrupt_down, should_interrupt_up = curb_tracker.update(
                curb_down_detected, curb_down_angle, curb_down_in_fan,
                curb_up_detected, curb_up_angle, curb_up_in_fan,
                current_time,
                road_area=road_area,
                sidewalk_area=sidewalk_area,
                sidewalk_best_direction=sidewalk_best_direction  
            )
            
            if should_interrupt_down or should_interrupt_up:
                mimic3_tts_thread.interrupt_current_speech()
                mimic3_tts_thread.clear_queue()
        
        # ===== 10. 处理beeping =====
        with profile_code_block("09_Beeping处理"):
            beep_active = False
            
            if curb_down_detected and curb_down_in_fan and curb_down_points is not None:
                classifications, min_distance, fan_area, min_x_value, has_points = fan_detector.classify_points(curb_down_points)
                if has_points:
                    beeping_pan_x = min_x_value / frame_width
                    color, object_color = get_color_and_object_color(fan_area)
                    beep_thread.update_distance(float(min_distance), object_color, beeping_pan_x)
                    beep_active = True
            
            if not beep_active and curb_up_detected and curb_up_in_fan and curb_up_points is not None:
                classifications, min_distance, fan_area, min_x_value, has_points = fan_detector.classify_points(curb_up_points)
                if has_points:
                    beeping_pan_x = min_x_value / frame_width
                    color, object_color = get_color_and_object_color(fan_area)
                    beep_thread.update_distance(float(min_distance), object_color, beeping_pan_x)
                    beep_active = True
            
            if not beep_active:
                beep_thread.update_distance(None, None, None)
        
        # with profile_code_block("09_Beeping处理"):
        #     beep_active = False
            
        #     # ✅ Curb Down Beeping（需要稳定 + 满足条件）
        #     if curb_down_detected and curb_down_in_fan and curb_down_points is not None:
        #         # ✅ 检查是否稳定（使用tracker的状态）
        #         if curb_tracker.curb_down_stable_state:
        #             # ✅ 检查是否在红色fan区域
        #             _, min_distance, fan_area, min_x_value, has_points = fan_detector.classify_points(curb_down_points)
                    
        #             if has_points:
        #                 in_red_fan = fan_area in [0, 1, 2]  # 红色区域
        #                 should_beep = (sidewalk_area < 0.2) or in_red_fan
                        
        #                 # ✅ 调试日志（每30帧）
        #                 if frame_count % 30 == 0:
        #                     logger.info(f"🔊 Beep Down Decision:")
        #                     logger.info(f"   Stable: {curb_tracker.curb_down_stable_state}, Should beep: {should_beep}")
        #                     logger.info(f"   Sidewalk: {sidewalk_area:.2%}, Red fan: {in_red_fan}")
                        
        #                 if should_beep:
        #                     beeping_pan_x = min_x_value / frame_width
        #                     color, object_color = get_color_and_object_color(fan_area)
        #                     beep_thread.update_distance(float(min_distance), object_color, beeping_pan_x)
        #                     beep_active = True
                            
        #                     if frame_count % 30 == 0:
        #                         logger.info(f"   ✅ Beeping activated (distance: {min_distance:.1f})")
        #         else:
        #             # 不稳定，不beep
        #             if frame_count % 90 == 0:
        #                 logger.info(f"⏸️  Curb down detected but not stable, no beep")
            
        #     # ✅ Curb Up Beeping（需要稳定 + 满足条件）
        #     if not beep_active and curb_up_detected and curb_up_in_fan and curb_up_points is not None:
        #         # ✅ 检查是否稳定
        #         if curb_tracker.curb_up_stable_state:
        #             # ✅ 检查是否在红色fan区域
        #             _, min_distance, fan_area, min_x_value, has_points = fan_detector.classify_points(curb_up_points)
                    
        #             if has_points:
        #                 in_red_fan = fan_area in [0, 1, 2]  # 红色区域
        #                 should_beep = (sidewalk_area < 0.2) or in_red_fan
                        
        #                 # ✅ 调试日志（每30帧）
        #                 if frame_count % 30 == 0:
        #                     logger.info(f"🔊 Beep Up Decision:")
        #                     logger.info(f"   Stable: {curb_tracker.curb_up_stable_state}, Should beep: {should_beep}")
        #                     logger.info(f"   Sidewalk: {sidewalk_area:.2%}, Red fan: {in_red_fan}")
                        
        #                 if should_beep:
        #                     beeping_pan_x = min_x_value / frame_width
        #                     color, object_color = get_color_and_object_color(fan_area)
        #                     beep_thread.update_distance(float(min_distance), object_color, beeping_pan_x)
        #                     beep_active = True
                            
        #                     if frame_count % 30 == 0:
        #                         logger.info(f"   ✅ Beeping activated (distance: {min_distance:.1f})")
        #         else:
        #             # 不稳定，不beep
        #             if frame_count % 90 == 0:
        #                 logger.info(f"⏸️  Curb up detected but not stable, no beep")
            
        #     # ✅ 如果没有激活beeping，停止
        #     if not beep_active:
        #         beep_thread.update_distance(None, None, None)
        
        # ===== 11. TTS语音引导 - curb_down =====
        with profile_code_block("10_TTS_curb_down"):
            if curb_down_detected and curb_down_points is not None:
                should_guide, stable_angle = curb_tracker.should_guide(
                    "curb_down", current_time, GUIDANCE_INTERVAL
                )
                
                if should_guide and stable_angle is not None:
                    # ✅ 检查是否在红色fan区域（最近的区域）
                    _, min_distance, fan_area, _, has_points_in_red = fan_detector.classify_points(curb_down_points)
                    in_red_fan = has_points_in_red and fan_area in [0, 1, 2]  # 红色区域是0,1,2
                    
                    # ✅ 添加条件：只有sidewalk < 20% 或 curb在红色fan区域时才提醒
                    should_warn_curb = (sidewalk_area < 0.2) or in_red_fan
                    
                    # ✅ 调试日志（每30帧）
                    if frame_count % 30 == 0:
                        logger.info(f"🔍 Curb Down Decision:")
                        logger.info(f"   Sidewalk: {sidewalk_area:.2%}, In red fan: {in_red_fan}")
                        logger.info(f"   Should warn: {should_warn_curb}")
                    
                    if should_warn_curb:
                        x_vals = curb_down_points[:, 0]
                        center_x = frame_width / 2
                        curb_center_x = np.mean(x_vals)
                        offset_x = curb_center_x - center_x
                        
                        guidance_text = None
                        
                        if abs(stable_angle) < ANGLE_THRESHOLD:
                            if curb_down_in_fan:
                                # 简短版本
                                guidance_text = "curb_down_ahead"
                        else:
                            avoid_angle = abs((offset_x / frame_width) * FOV_DEGREES)
                            
                            if avoid_angle > 5:
                                avoid_direction = "right" if offset_x < 0 else "left"
                                guidance_text = generate_guidance_text(
                                    angle=avoid_angle,
                                    direction=avoid_direction,
                                    curb_type='down'
                                )
                        
                        if guidance_text:
                            mimic3_tts_thread.enqueue_phrase(guidance_text, priority=False)
                            curb_tracker.mark_guidance_given("curb_down", current_time)
                            logger.info(f"🗣️ Curb Down: {guidance_text}")
                    else:
                        # ✅ 在sidewalk上且curb不在红色区域，不提醒
                        if frame_count % 90 == 0:
                            logger.info(f"⏸️  Curb down detected but not warning (sidewalk: {sidewalk_area:.2%}, red fan: {in_red_fan})")
        
        # ===== 12. TTS语音引导 - curb_up =====
        with profile_code_block("11_TTS_curb_up"):
            if curb_up_detected and curb_up_points is not None:
                should_guide, stable_angle = curb_tracker.should_guide(
                    "curb_up", current_time, GUIDANCE_INTERVAL
                )
                
                if should_guide and stable_angle is not None:
                    # ✅ 检查是否在红色fan区域（最近的区域）
                    _, min_distance, fan_area, _, has_points_in_red = fan_detector.classify_points(curb_up_points)
                    in_red_fan = has_points_in_red and fan_area in [0, 1, 2]  # 红色区域是0,1,2
                    
                    # ✅ 添加条件：只有sidewalk < 20% 或 curb在红色fan区域时才提醒
                    should_warn_curb = (sidewalk_area < 0.2) or in_red_fan
                    
                    # ✅ 调试日志（每30帧）
                    if frame_count % 30 == 0:
                        logger.info(f"🔍 Curb Up Decision:")
                        logger.info(f"   Sidewalk: {sidewalk_area:.2%}, In red fan: {in_red_fan}")
                        logger.info(f"   Should warn: {should_warn_curb}")
                    
                    if should_warn_curb:
                        x_vals = curb_up_points[:, 0]
                        center_x = frame_width / 2
                        curb_center_x = np.mean(x_vals)
                        offset_x = curb_center_x - center_x
                        
                        guidance_text = None
                        
                        if abs(stable_angle) < ANGLE_THRESHOLD:
                            if curb_up_in_fan:
                                # 简短版本
                                guidance_text = "curb_up_ahead"
                        else:
                            avoid_angle = abs((offset_x / frame_width) * FOV_DEGREES)
                            
                            if avoid_angle > 5:
                                turn_angle = 90 - avoid_angle
                                opposite_direction = "left" if offset_x < 0 else "right"
                                guidance_text = generate_guidance_text(
                                    angle=turn_angle,
                                    direction=opposite_direction,
                                    curb_type='up'
                                )
                        
                        if guidance_text:
                            mimic3_tts_thread.enqueue_phrase(guidance_text, priority=False)
                            curb_tracker.mark_guidance_given("curb_up", current_time)
                            logger.info(f"🗣️ Curb Up: {guidance_text}")
                    else:
                        # ✅ 在sidewalk上且curb不在红色区域，不提醒
                        if frame_count % 90 == 0:
                            logger.info(f"⏸️  Curb up detected but not warning (sidewalk: {sidewalk_area:.2%}, red fan: {in_red_fan})")
        
        # ✅ ===== 13. Open Path 统一语音引导（根据绿色框位置）=====
        # with profile_code_block("12_TTS_open_path"):
        #     # 判断是否应该给出引导
        #     should_guide_open = curb_tracker.should_guide_open_path(current_time)
            
        #     # ✅ 优先级：curb在扇形区域内时不给open path引导
        #     # （改为只检查curb是否在fan area中，而不是是否检测到curb）
        #     if not (curb_down_in_fan or curb_up_in_fan):
                
        #         # ✅ 根据稳定的sidewalk方向给出引导
        #         if should_guide_open and sidewalk_area > 0.2:
        #             should_guide_direction, stable_direction = curb_tracker.should_guide_sidewalk_direction(current_time)
                    
        #             if should_guide_direction and stable_direction is not None:
        #                 # 根据绿色框位置选择语音
        #                 if stable_direction == 'left':
        #                     open_path_text = "obstacle_ahead_move_left"
        #                     logger.info(f"🚧 Best path: LEFT (curb outside fan)")
        #                 elif stable_direction == 'right':
        #                     open_path_text = "obstacle_ahead_move_right"
        #                     logger.info(f"🚧 Best path: RIGHT (curb outside fan)")
        #                 elif stable_direction == 'center':
        #                     open_path_text = "path_clear"
        #                     logger.info(f"✅ Path clear: CENTER (curb outside fan)")
        #                 else:
        #                     open_path_text = None
                        
        #                 if open_path_text:
        #                     mimic3_tts_thread.enqueue_phrase(open_path_text, priority=False)
        #                     curb_tracker.mark_open_path_guidance_given(current_time)
        #                     curb_tracker.mark_sidewalk_guidance_given(current_time)
                            
        #                     logger.info(f"   Road: {road_area:.2%}, Sidewalk: {sidewalk_area:.2%}")
        #                     logger.info(f"   SW Densities - L:{sidewalk_left_density:.2f} C:{sidewalk_center_density:.2f} R:{sidewalk_right_density:.2f}")
        #                     logger.info(f"   Curb status - Down:{curb_down_detected}(in_fan:{curb_down_in_fan}) Up:{curb_up_detected}(in_fan:{curb_up_in_fan})")
        #             else:
        #                 # ✅ 调试：为什么没有触发
        #                 if frame_count % 90 == 0 and sidewalk_area > 0.2:
        #                     logger.info(f"⏸️  Open path not triggered - should_guide_direction:{should_guide_direction}, stable_direction:{stable_direction}")
        #         else:
        #             # ✅ 调试：为什么没有触发
        #             if frame_count % 90 == 0 and not (curb_down_in_fan or curb_up_in_fan):
        #                 logger.info(f"⏸️  Open path conditions - should_guide_open:{should_guide_open}, sidewalk_area:{sidewalk_area:.2%}")
        #     else:
        #         # ✅ 调试：curb在fan area中
        #         if frame_count % 90 == 0:
        #             logger.info(f"🚫 Open path blocked - Curb in fan (down:{curb_down_in_fan}, up:{curb_up_in_fan})")
        with profile_code_block("12_TTS_open_path"):
            # 判断是否应该给出引导
            should_guide_open = curb_tracker.should_guide_open_path(current_time)
            
            # 优先级：curb在扇形区域内时不给open path引导
            if not (curb_down_in_fan or curb_up_in_fan):
                
                if should_guide_open and best_direction is not None and vibration_intensity != 'none':
                    # ✅ 根据论文的振动强度选择简洁语音
                    if best_direction == 'left':
                        if vibration_intensity == 'strong':
                            open_path_text = "turn_left"        # "Turn left."
                        else:
                            open_path_text = "slight_left"      # "Slight left."
                            
                    elif best_direction == 'right':
                        if vibration_intensity == 'strong':
                            open_path_text = "turn_right"       # "Turn right."
                        else:
                            open_path_text = "slight_right"     # "Slight right."
                            
                    else:  # center
                        if vibration_intensity == 'strong':
                            open_path_text = "go_straight"      # "Go straight."
                        else:
                            open_path_text = "caution"          # "Caution."
                    
                    mimic3_tts_thread.enqueue_phrase(open_path_text, priority=False)
                    curb_tracker.mark_open_path_guidance_given(current_time)
                    
                    logger.info(f"🗣️ Open Path: {open_path_text} ({best_direction}/{vibration_intensity})")
                    logger.info(f"   Sidewalk: {sidewalk_area:.2%}, Best column: {best_column}")
        
        # ===== 14. 绘制可视化 =====
        with profile_code_block("13_可视化"):
            if curb_down_points is not None:
                x_vals = curb_down_points[:, 0]
                y_vals = curb_down_points[:, 1]
                for i in range(1, len(x_vals)):
                    cv2.line(dst, (int(x_vals[i-1]), int(y_vals[i-1])), 
                            (int(x_vals[i]), int(y_vals[i])), (0, 0, 255), 2)
                if curb_down_angle is not None:
                    cv2.putText(dst, f"Down angle: {curb_down_angle}", 
                               (10, frame_height - 60), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
            
            if curb_up_points is not None:
                x_vals = curb_up_points[:, 0]
                y_vals = curb_up_points[:, 1]
                for i in range(1, len(x_vals)):
                    cv2.line(dst, (int(x_vals[i-1]), int(y_vals[i-1])), 
                            (int(x_vals[i]), int(y_vals[i])), (0, 255, 255), 2)
                if curb_up_angle is not None:
                    cv2.putText(dst, f"Up angle: {curb_up_angle}", 
                               (10, frame_height - 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
            
            for axes, color, start_angle_draw, end_angle_draw in zip(
                fan_config.axes_lengths, fan_config.fan_colors, 
                fan_config.start_angles, fan_config.end_angles
            ):
                cv2.ellipse(dst, fan_config.center, axes, 0, start_angle_draw, end_angle_draw, color, 1)
            
            cv2.line(dst, fan_config.center, left_line, (255, 255, 255), 1)
            cv2.line(dst, fan_config.center, right_line, (255, 255, 255), 1)
            cv2.line(dst, fan_config.center, mid_left_line, (255, 255, 255), 1)
            cv2.line(dst, fan_config.center, mid_right_line, (255, 255, 255), 1)
            
            fps = int(1 / (new_frame_time - prev_frame_time)) if (new_frame_time - prev_frame_time) > 0 else 0
            prev_frame_time = new_frame_time
            
            beep_status = "ON" if beep_active else "OFF"
            mode_text = "VIDEO" if VIDEO_TEST_MODE else "CAMERA"
            open_path_status = "CLEAR" if curb_tracker.open_path_stable_state else "OBST"
            
            # ✅ 显示sidewalk最佳方向
            sidewalk_status = f"SW:{sidewalk_best_direction.upper() if sidewalk_best_direction else 'N/A'}"
            
            status_text = f"FPS:{fps} | {mode_text} | Beep:{beep_status} | Path:{open_path_status} | {sidewalk_status}"
            cv2.putText(dst, status_text, (10, frame_height - 20), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 0), 1)
            
            traversable_text = f"Road:{road_area:.1%} | SW:{sidewalk_area:.1%}"
            cv2.putText(dst, traversable_text, (10, 30), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
            
            # ========== 右上角：帧统计 ==========
            stats_lines = [
                f"Total:{frame_count + 1}",
                f"curb_dn:{class_frame_counts[0]}",
                f"curb_up:{class_frame_counts[1]}",
                f"road:   {class_frame_counts[2]}",
                f"sidwlk: {class_frame_counts[3]}",
            ]
            for line_idx, line_text in enumerate(stats_lines):
                text_size, _ = cv2.getTextSize(line_text, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
                text_x = frame_width - text_size[0] - 10
                text_y = 20 + line_idx * 22
                # 半透明背景
                cv2.rectangle(dst,
                              (text_x - 4, text_y - 14),
                              (text_x + text_size[0] + 4, text_y + 4),
                              (0, 0, 0), -1)
                cv2.putText(dst, line_text, (text_x, text_y),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
            
            # ✅ 显示open path追踪状态（第二行）
            open_path_stable_text = "OP_STABLE" if curb_tracker.open_path_stable_state else "op_unstable"
            curb_in_fan_text = f"Curb:{'IN' if (curb_down_in_fan or curb_up_in_fan) else 'OUT'}"
            direction_history_text = f"Dir:{sidewalk_best_direction if sidewalk_best_direction else 'N/A'}"
            
            debug_text = f"{open_path_stable_text} | {curb_in_fan_text} | {direction_history_text}"
            cv2.putText(dst, debug_text, (10, 55), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 200), 1)
        
        # ===== 15. 输出帧 =====
        with profile_code_block("14_输出帧"):
            if VIDEO_TEST_MODE:
                cv2.namedWindow('Video Test', cv2.WINDOW_NORMAL)
                cv2.imshow('Video Test', dst)
                
                key = cv2.waitKey(1) & 0xFF
                if key == 27 or key == ord('q'):
                    logger.info("🛑 User pressed ESC/q")
                    exit_flag.set()
                    break
            
            elif video_source_type == "gstreamer":
                cap.push_processed_frame(dst)
            
            elif out is not None:
                out.write(dst)
                cv2.namedWindow('Camera', cv2.WINDOW_NORMAL)
                cv2.imshow('Camera', dst)
                if cv2.waitKey(1) & 0xFF == ord('q'):
                    exit_flag.set()
                    break
        
        frame_count += 1
        
        if frame_count % 100 == 0:
            logger.info(f"Processed {frame_count} frames, FPS: {fps}")
            tracker.print_report()
            
            # ✅ 添加追踪器状态报告
            logger.info("="*60)
            logger.info("📊 Tracker Status Report:")
            logger.info(f"  Open Path Stable: {curb_tracker.open_path_stable_state}")
            logger.info(f"  Open Path History: {list(curb_tracker.open_path_history)}")
            logger.info(f"  Sidewalk Direction History: {list(curb_tracker.sidewalk_best_direction_history)}")
            logger.info(f"  Last Open Path Guidance: {current_time - curb_tracker.last_open_path_guidance_time:.1f}s ago")
            logger.info(f"  Last Sidewalk Guidance: {current_time - curb_tracker.last_sidewalk_guidance_time:.1f}s ago")
            logger.info("="*60)

except KeyboardInterrupt:
    logger.info("\n🛑 Interrupted by user")

except Exception as e:
    logger.error(f"❌ Error in main loop: {e}", exc_info=True)

finally:
    logger.info("="*70)
    logger.info("📊 FINAL PERFORMANCE REPORT")
    logger.info("="*70)
    tracker.print_report()
    
    logger.info("Cleaning up...")
    
    beep_thread.stop()
    beep_thread.join()
    
    mimic3_tts_thread.stop()
    mimic3_tts_thread.join()

    if HAPTIC_ENABLED:
        haptic_controller.stop()
        haptic_controller.join()
    
    cap.release()
    
    if out is not None:
        out.release()
    
    cv2.destroyAllWindows()
    
    logger.info("✅ Program ended cleanly")