use std::collections::VecDeque;

use parking_lot::Mutex;

#[derive(Default)]
pub struct LogBuffer {
  inner: Mutex<VecDeque<String>>,
  max_lines: usize,
}

impl LogBuffer {
  pub fn new(max_lines: usize) -> Self {
    Self { inner: Mutex::new(VecDeque::new()), max_lines }
  }

  pub fn push(&self, line: impl Into<String>) {
    let mut q = self.inner.lock();
    q.push_back(line.into());
    while q.len() > self.max_lines {
      q.pop_front();
    }
  }

  pub fn tail(&self, lines: usize) -> Vec<String> {
    let q = self.inner.lock();
    let len = q.len();
    let start = len.saturating_sub(lines);
    q.iter().skip(start).cloned().collect()
  }
}
