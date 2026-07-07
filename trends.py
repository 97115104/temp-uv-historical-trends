import pandas as pd
import numpy as np
import matplotlib.pyplot as plt

# 1. Define the timeframe: November 1993 to July 2026
dates = pd.date_range(start='1993-11-01', end='2026-07-01', freq='MS')

# 2. Data Retrieval (Simulated for demonstration)
# In practice, replace 'uv_values' with an API call to NASA POWER or NOAA.
# Simulating Covina's UV index with seasonal variation + slight historical noise.
uv_values = 6.5 + 4.5 * np.sin(2 * np.pi * (dates.month - 3) / 12) + np.random.normal(0, 0.3, len(dates))

# Create DataFrame
df = pd.DataFrame({'Date': dates, 'UV_Index': np.clip(uv_values, 0, None)})
df.set_index('Date', inplace=True)

# 3. Calculate Year-over-Year (YoY) Percentage Change
# Shift by 12 months to compare the same month from the previous year
df['YoY_Pct_Change'] = df['UV_Index'].pct_change(periods=12) * 100

# Calculate the average YoY change across the entire dataset up to July 2026
average_yoy_change = df['YoY_Pct_Change'].mean()

# 4. Plot the Data
fig, ax1 = plt.subplots(figsize=(14, 7))

# Primary Axis: Monthly UV Index
ax1.plot(df.index, df['UV_Index'], color='#1f77b4', alpha=0.8, label='Monthly UV Index')
ax1.set_xlabel('Year', fontweight='bold')
ax1.set_ylabel('UV Index', color='#1f77b4', fontweight='bold')
ax1.tick_params(axis='y', labelcolor='#1f77b4')

# Secondary Axis: YoY Percentage Change
ax2 = ax1.twinx()
ax2.plot(df.index, df['YoY_Pct_Change'], color='#d62728', alpha=0.5, linewidth=1, label='YoY % Change')
ax2.set_ylabel('YoY % Change', color='#d62728', fontweight='bold')
ax2.tick_params(axis='y', labelcolor='#d62728')

# Titles and Formatting
plt.title(f'Covina, CA: Historical UV Index & YoY Change (Nov 1993 - Jul 2026)\nAverage YoY Change: {average_yoy_change:.2f}%', fontsize=14)
ax1.grid(True, linestyle='--', alpha=0.6)

# Combine legends
lines_1, labels_1 = ax1.get_legend_handles_labels()
lines_2, labels_2 = ax2.get_legend_handles_labels()
ax1.legend(lines_1 + lines_2, labels_1 + labels_2, loc='upper left')

plt.tight_layout()
plt.show()