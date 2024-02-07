import numpy as np
import argparse

def parse_time(time_str):
    """Parse time string to milliseconds."""
    if ':' in time_str:  # Handle m:ss.mmm format
        minutes, seconds = time_str.split(':')
        total_seconds = int(minutes) * 60 + float(seconds)
        return total_seconds * 1000  # Convert to milliseconds
    else:  # Handle the standard ms format
        return float(time_str[:-2])  # Remove 'ms' and convert to float

def parse_times(filename):
    retrieve_times = []
    verify_times = []
    with open(filename, 'r') as file:
        lines = file.readlines()
        for i in range(0, len(lines), 2):  # Assuming each command output is exactly 2 lines
            retrieve_line = lines[i].strip()
            verify_line = lines[i+1].strip() if (i+1) < len(lines) else ""
            if 'retrieve:' in retrieve_line:
                retrieve_time_str = retrieve_line.split()[1]
                retrieve_times.append(parse_time(retrieve_time_str))
            if 'verify:' in verify_line:
                verify_time = float(verify_line.split()[1][:-2])  # Remove 'ms' and convert to float
                verify_times.append(verify_time)
    return retrieve_times, verify_times

def filter_outliers(data, m=2):
    """Filter outliers that are more than m standard deviations from the mean."""
    mean = np.mean(data)
    std = np.std(data)
    filtered = [x for x in data if abs(x - mean) <= m * std]
    return filtered

def compute_stats(values):
    avg = np.mean(values)
    std = np.std(values)
    return avg, std

# Argument parsing
parser = argparse.ArgumentParser(description='Process time logs and compute statistics.')
parser.add_argument('filename', type=str, help='Path to the log file')
parser.add_argument('--exclude-outliers', action='store_true', help='Exclude outliers based on standard deviation')
args = parser.parse_args()

retrieve_times, verify_times = parse_times(args.filename)

if args.exclude_outliers:
    retrieve_times = filter_outliers(retrieve_times)
    verify_times = filter_outliers(verify_times)

retrieve_avg, retrieve_std = compute_stats(retrieve_times)
verify_avg, verify_std = compute_stats(verify_times)

print(f"Retrieve - Avg: {retrieve_avg:.2f}ms, Std: {retrieve_std:.2f}ms")
print(f"Verify - Avg: {verify_avg:.2f}ms, Std: {verify_std:.2f}ms")
