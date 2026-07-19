from PIL import Image
import numpy as np

def make_gold_transparent(input_path, output_path):
    # Open the image and convert to RGBA
    img = Image.open(input_path).convert("RGBA")
    data = np.array(img)
    
    # Define the gold background color (R, G, B)
    # You may need to adjust these values slightly based on your specific logo
    gold_color = [190, 160, 100] 
    
    # Create a mask where pixels match the gold color
    # np.all checks if the pixel matches the target color across RGB channels
    mask = np.all(data[:, :, :3] >= gold_color, axis=-1)
    
    # Set the pixels matching the mask to transparent (R=0, G=0, B=0, A=0)
    data[mask] = [0, 0, 0, 0]
    
    # Save the resulting transparent PNG
    new_img = Image.fromarray(data)
    new_img.save(output_path, "PNG")
    print(f"Transparent logo saved as: {output_path}")

# Usage

make_gold_transparent("image.png", "visa-logo-transparent.png")